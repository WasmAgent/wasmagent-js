import { fileURLToPath } from "node:url";
import { type ResourceLimits, Worker } from "node:worker_threads";
import type { CapabilityManifest, KernelOptions, KernelResult, WasmKernel } from "./types.js";

// Q10: use new URL() for robust sibling resolution — cross-platform, no string hacks.
// In production (after tsc builds), import.meta.url points to dist/executor/JsKernel.js
// so "./JsKernelWorker.js" resolves to dist/executor/JsKernelWorker.js correctly.
// In tests (vitest vite transform), import.meta.url points to src/executor/JsKernel.ts
// and worker_threads can't execute TypeScript — swap src→dist for that case only.
function resolveWorkerPath(): string {
  const workerUrl = new URL("./JsKernelWorker.js", import.meta.url);
  const path = fileURLToPath(workerUrl);
  // Vitest transforms TS in-place; path will contain /src/executor/ in that case.
  return path.replace(/[/\\]src[/\\]executor[/\\]/, "/dist/executor/");
}

/**
 * Translate a memory ceiling in bytes into node:worker_threads `resourceLimits`
 * (issue #192 — configurable memory limits for the default kernel).
 *
 * V8 enforces `maxOldGenerationSizeMb` as a HARD cap on the worker's
 * old-generation (long-lived) heap. A guest that exhausts it aborts with a
 * FATAL OOM, terminating the worker — which JsKernel surfaces as a `run()`
 * rejection (see the `exit` handler in `run()`). V8 accepts heap limits only in
 * whole-MiB granularity, so we round UP (never down) to avoid silently widening
 * the cap below what the caller asked for.
 *
 * Returns `undefined` when no limit is configured, so callers can pass the
 * result straight to `new Worker(path, { resourceLimits })` with no branch.
 */
export function memoryBytesToResourceLimits(bytes?: number): ResourceLimits | undefined {
  if (bytes === undefined || bytes <= 0) return undefined;
  const mib = Math.max(1, Math.ceil(bytes / (1024 * 1024)));
  return { maxOldGenerationSizeMb: mib };
}

/**
 * Default JS kernel — executes agent code in an isolated worker_threads Worker.
 *
 * The vm sandbox runs in a dedicated OS thread, not in the caller's event loop.
 * Synchronous infinite loops (`while(true){}`) are terminated by a deadline poll
 * + worker.terminate() — the OS thread is fully killed, leaving no zombie processes.
 *
 * Timeout mechanism: a setImmediate polling loop checks Date.now() against a
 * deadline. When the deadline fires, worker.terminate() kills the thread and the
 * promise rejects. This does NOT use SharedArrayBuffer or Atomics — synchronisation
 * is handled entirely through the worker_threads message channel (postMessage /
 * structured clone), which provides its own happens-before guarantees.
 *
 * State persists across run() calls: the worker is long-lived and its vm context
 * keeps variables alive between agent steps. After a timeout the worker is replaced
 * so the next step starts with a clean context.
 *
 * This is NOT a production security boundary — the worker still has access to
 * Node.js APIs. Use isolated-vm or WasmtimeKernel for hard security isolation.
 */
export class JsKernel implements WasmKernel {
  #worker: Worker | null = null;
  #disposed = false;
  readonly #timeoutMs: number;
  readonly #maxMemoryBytes: number | undefined;
  #serial = 0;

  constructor(opts?: KernelOptions) {
    this.#timeoutMs = opts?.timeoutMs ?? 5_000;
    // Issue #192: hard memory cap for the default kernel. Honoured at worker
    // spawn via V8 resourceLimits — a live worker's heap limit cannot be
    // resized, so this is constructor-level only (a per-call memoryLimitBytes
    // passed to run() is advisory). `maxMemoryBytes` (KernelOptions) takes
    // precedence; otherwise fall back to a capability manifest pinned at
    // construction time.
    this.#maxMemoryBytes = opts?.maxMemoryBytes ?? opts?.capabilities?.memoryLimitBytes;
    // Q9: do NOT spawn worker here — defer to first run() call.
    // Constructing JsKernel (or CodeAgent) should not fork an OS thread;
    // the cost is paid only when the kernel is actually used.
  }

  #getOrSpawnWorker(): Worker {
    this.#worker ??= this.#spawnWorker();
    return this.#worker;
  }

  #spawnWorker(): Worker {
    const w = new Worker(resolveWorkerPath(), {
      // Issue #192: V8 enforces this as a hard old-generation heap cap on the
      // worker. `undefined` (no limit configured) leaves the default heap alone.
      resourceLimits: memoryBytesToResourceLimits(this.#maxMemoryBytes),
    });
    // Suppress "Worker exited" errors that fire when we intentionally terminate on timeout.
    w.on("error", () => {});
    return w;
  }

  async run(code: string, capabilities?: Partial<CapabilityManifest>): Promise<KernelResult> {
    if (this.#disposed) {
      throw new Error("KernelError: cannot run() on a disposed JsKernel");
    }
    // Lazy init: spawn worker on first run(), not at construction time.
    const worker = this.#getOrSpawnWorker();

    const serial = ++this.#serial;

    // Pass capability manifest directly — the worker runs in full Node.js context
    // and can reconstruct fetch closures and __fs__ objects from the allow-lists.
    const capPayload = capabilities ?? null;

    // Per-call timeout: capability.cpuMs (if set) tightens the kernel default.
    // We never widen — a constructor-side timeoutMs is the host's hard ceiling.
    const perCallTimeout =
      capabilities?.cpuMs != null && capabilities.cpuMs > 0
        ? Math.min(this.#timeoutMs, capabilities.cpuMs)
        : this.#timeoutMs;

    // Single promise that resolves/rejects when the worker responds OR dies/times out.
    return new Promise<KernelResult>((resolve, reject) => {
      const handler = (msg: {
        type: "result" | "error";
        serial: number;
        output?: unknown;
        logs?: string[];
        isFinalAnswer?: boolean;
        message?: string;
      }) => {
        if (msg.serial !== serial) return;
        worker.off("message", handler);
        worker.off("exit", onExit);
        clearTimeout(timer);
        if (msg.type === "error") {
          reject(new Error(`KernelError: ${msg.message ?? "unknown"}`));
        } else {
          resolve({
            output: msg.output,
            logs: msg.logs ?? [],
            isFinalAnswer: msg.isFinalAnswer ?? false,
          });
        }
      };

      const timer = setTimeout(() => {
        worker.off("message", handler);
        worker.off("exit", onExit);
        worker.terminate().catch(() => {});
        this.#worker = null;
        reject(new Error(`KernelError: Script execution timed out after ${perCallTimeout}ms`));
      }, perCallTimeout);

      // Issue #192: if the worker dies before responding — most often a V8
      // FATAL OOM when it blows past resourceLimits.maxOldGenerationSizeMb —
      // reject promptly with a clear message instead of waiting out the timeout.
      // Declared after `handler`/`timer` because all three close over each other
      // and are only invoked asynchronously (after every binding is initialised).
      const onExit = (code: number) => {
        worker.off("message", handler);
        worker.off("exit", onExit);
        clearTimeout(timer);
        this.#worker = null;
        const hint =
          this.#maxMemoryBytes !== undefined
            ? " — sandbox likely exceeded its memoryLimitBytes"
            : "";
        reject(new Error(`KernelError: sandbox worker exited with code ${code}${hint}`));
      };

      worker.on("message", handler);
      worker.once("exit", onExit);
      worker.postMessage({
        type: "run",
        code,
        capabilities: capPayload,
        serial,
        timeoutMs: perCallTimeout,
      });
    });
  }

  async reset(): Promise<void> {
    if (this.#worker) {
      this.#worker.terminate().catch(() => {});
    }
    // Q9: don't eagerly spawn — next run() will create a fresh worker lazily.
    this.#worker = null;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#disposed = true;
    if (this.#worker) {
      await this.#worker.terminate();
      this.#worker = null;
    }
  }
}
