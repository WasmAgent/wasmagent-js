import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type {
  CapabilityManifest,
  KernelOptions,
  KernelResult,
  WasmKernel,
} from "./types.js";

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
  readonly #timeoutMs: number;
  #serial = 0;

  constructor(opts?: KernelOptions) {
    this.#timeoutMs = opts?.timeoutMs ?? 5_000;
    // Q9: do NOT spawn worker here — defer to first run() call.
    // Constructing JsKernel (or CodeAgent) should not fork an OS thread;
    // the cost is paid only when the kernel is actually used.
  }

  #getOrSpawnWorker(): Worker {
    return (this.#worker ??= this.#spawnWorker());
  }

  #spawnWorker(): Worker {
    const w = new Worker(resolveWorkerPath());
    // Suppress "Worker exited" errors that fire when we intentionally terminate on timeout.
    w.on("error", () => {});
    return w;
  }

  async run(
    code: string,
    capabilities?: Partial<CapabilityManifest>
  ): Promise<KernelResult> {
    // Lazy init: spawn worker on first run(), not at construction time.
    const worker = this.#getOrSpawnWorker();

    const serial = ++this.#serial;

    // Pass capability manifest directly — the worker runs in full Node.js context
    // and can reconstruct fetch closures and __fs__ objects from the allow-lists.
    const capPayload = capabilities ?? null;

    // Single promise that resolves/rejects when the worker responds OR times out.
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
        worker.terminate().catch(() => {});
        this.#worker = null;
        reject(new Error(`KernelError: Script execution timed out after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);

      worker.on("message", handler);
      worker.postMessage({ type: "run", code, capabilities: capPayload, serial, timeoutMs: this.#timeoutMs });
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
    if (this.#worker) {
      await this.#worker.terminate();
      this.#worker = null;
    }
  }
}
