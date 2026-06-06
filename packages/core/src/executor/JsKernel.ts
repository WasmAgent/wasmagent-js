import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  CapabilityManifest,
  KernelOptions,
  KernelResult,
  WasmKernel,
} from "./types.js";

// WORKER_PATH is computed lazily (inside the class) rather than at module level
// so that merely importing JsKernel (e.g. for re-export) does not crash in
// environments that lack import.meta.url (Cloudflare Workers). The Workers
// bundle includes @agentkit-js/core but CodeAgent uses QuickJSKernel there —
// JsKernel is imported but never instantiated, so the lazy computation is safe.
function resolveWorkerPath(): string {
  const __dir = dirname(fileURLToPath(import.meta.url));
  return __dir.includes("/src/")
    ? __dir.replace("/src/", "/dist/") + "/JsKernelWorker.js"
    : join(__dir, "JsKernelWorker.js");
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
    this.#worker = this.#spawnWorker();
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
    if (!this.#worker) {
      this.#worker = this.#spawnWorker();
    }

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
        this.#worker!.off("message", handler);
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

      // Q4: single setTimeout instead of the old setImmediate polling loop.
      // The polling loop created O(timeoutMs) Immediate objects (one per event-loop
      // iteration) and provided no better precision than a one-shot timer.
      // setTimeout fires once, has equivalent precision, and zero GC churn.
      const timer = setTimeout(() => {
        this.#worker!.off("message", handler);
        this.#worker!.terminate().catch(() => {});
        this.#worker = null;
        reject(new Error(`KernelError: Script execution timed out after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);

      this.#worker!.on("message", handler);
      this.#worker!.postMessage({ type: "run", code, capabilities: capPayload, serial });
    });
  }

  async reset(): Promise<void> {
    if (this.#worker) {
      this.#worker.terminate().catch(() => {});
    }
    this.#worker = this.#spawnWorker();
  }

  async snapshot(): Promise<Uint8Array> {
    throw new Error(
      "JsKernel does not support snapshot/restore — state cannot be faithfully serialised. " +
        "Use WasmtimeKernel for true linear-memory snapshots."
    );
  }

  async restore(_snapshot: Uint8Array): Promise<void> {
    throw new Error(
      "JsKernel does not support snapshot/restore — use WasmtimeKernel."
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#worker) {
      await this.#worker.terminate();
      this.#worker = null;
    }
  }
}
