import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  CapabilityManifest,
  KernelOptions,
  KernelResult,
  WasmKernel,
} from "./types.js";

// The worker must be a compiled .js file — worker_threads cannot execute TypeScript.
// import.meta.url points to src/ during tests (via vitest's vite transform) but the
// worker needs the actual compiled output. We resolve relative to __dir and swap
// the src path for dist if we're running from source.
const __dir = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = __dir.includes("/src/")
  ? __dir.replace("/src/", "/dist/") + "/JsKernelWorker.js"
  : join(__dir, "JsKernelWorker.js");

/**
 * Default JS kernel — executes agent code in an isolated worker_threads Worker.
 *
 * The vm sandbox runs in a dedicated OS thread, not in the caller's event loop.
 * Synchronous infinite loops (`while(true){}`) are terminated by Atomics.wait
 * timeout + worker.terminate() — the thread is fully killed, leaving no zombie
 * processes behind (fixes the 2026-06-06 fan-spin incident).
 *
 * State persists across run() calls: the worker is long-lived and the vm context
 * it holds keeps variables alive between steps. After a timeout the worker is
 * replaced so the next step starts with a clean context.
 *
 * This is NOT a production security boundary for adversarial code — the worker
 * still has access to Node.js APIs unless stripped. Use WasmtimeKernel or
 * isolated-vm for hard security boundaries.
 */
export class JsKernel implements WasmKernel {
  #worker: Worker | null = null;
  #sab: SharedArrayBuffer;
  #notifyBuf: Int32Array;
  readonly #timeoutMs: number;
  #serial = 0;

  constructor(opts?: KernelOptions) {
    this.#timeoutMs = opts?.timeoutMs ?? 5_000;
    this.#sab = new SharedArrayBuffer(4);
    this.#notifyBuf = new Int32Array(this.#sab);
    this.#worker = this.#spawnWorker();
  }

  #spawnWorker(): Worker {
    Atomics.store(this.#notifyBuf, 0, 0);
    const w = new Worker(WORKER_PATH, { workerData: { sab: this.#sab } });
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

    // Pass capability manifest directly — the worker's full Node.js context can
    // reconstruct fetch closures and __fs__ objects from the allow-lists.
    const capPayload = capabilities ?? null;

    // Reset the SAB to 0 so Atomics.wait below blocks until the worker writes serial.
    Atomics.store(this.#notifyBuf, 0, 0);

    // Single promise that resolves/rejects when the worker responds OR times out.
    return new Promise<KernelResult>((resolve, reject) => {
      const deadline = Date.now() + this.#timeoutMs;

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
        clearImmediate(timeoutHandle);
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

      this.#worker!.on("message", handler);
        this.#worker!.postMessage({ type: "run", code, capabilities: capPayload, serial });

      // Polling loop to enforce timeout without blocking the event loop.
      let timeoutHandle: NodeJS.Immediate;
      const poll = () => {
        if (Date.now() < deadline) {
          timeoutHandle = setImmediate(poll);
          return;
        }
        // Timed out — remove listener, kill worker, reject.
        this.#worker!.off("message", handler);
        this.#worker!.terminate().catch(() => {});
        this.#worker = null;
        reject(new Error(`KernelError: Script execution timed out after ${this.#timeoutMs}ms`));
      };
      timeoutHandle = setImmediate(poll);
    });
  }

  async reset(): Promise<void> {
    if (this.#worker) {
      this.#worker.terminate().catch(() => {});
    }
    this.#sab = new SharedArrayBuffer(4);
    this.#notifyBuf = new Int32Array(this.#sab);
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
