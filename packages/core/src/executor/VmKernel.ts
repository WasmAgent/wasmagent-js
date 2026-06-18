import { createContext, Script } from "node:vm";
import { buildCapabilityGlobals } from "./capabilities.js";
import type { CapabilityManifest, KernelOptions, KernelResult, WasmKernel } from "./types.js";

/**
 * VmKernel — pure-JS in-process kernel using Node's vm module.
 *
 * NOTE: node:vm is NOT a security boundary. Code runs in the same process and
 * can escape the sandbox with sufficient effort. Use this kernel only for
 * development, testing, and low-trust scenarios.
 *
 * For language-level isolation, use the WASM kernels:
 *   @wasmagent/kernel-quickjs  (edge-safe, no native deps)
 *   @wasmagent/kernel-pyodide  (CPython-in-WASM)
 *   @wasmagent/kernel-wasmtime (Javy/WASM via native addon)
 *
 * For full process isolation, use RemoteSandboxKernel with an E2B or
 * Cloudflare Sandbox provider.
 *
 * Designed to be serverless-safe (no native deps) and compatible with
 * AWS Lambda. Capability enforcement mirrors JsKernel
 * (deny-all baseline with per-call allow-list injection).
 */
export class VmKernel implements WasmKernel {
  #context: ReturnType<typeof createContext>;
  #logs: string[] = [];
  #disposed = false;
  readonly #timeoutMs: number;

  constructor(opts?: KernelOptions) {
    // Default 5s — finite by construction. A bare `new VmKernel()`
    // previously had `undefined` timeout, which let `while(true){}`
    // hang the host (the kernel runs in-process, not in a worker
    // thread, so there's no isolation; cf. JsKernel). Match the
    // QuickJSKernel/WasmtimeKernel default for consistency.
    this.#timeoutMs = opts?.timeoutMs ?? 5_000;
    this.#context = this.#createSandbox();
  }

  #createSandbox(capabilities?: Partial<CapabilityManifest>): ReturnType<typeof createContext> {
    const logCapture = (...args: unknown[]) => {
      this.#logs.push(args.map(String).join(" "));
    };

    const capGlobals = buildCapabilityGlobals(capabilities);

    return createContext({
      console: {
        log: logCapture,
        warn: logCapture,
        error: logCapture,
      },
      Math,
      JSON,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Promise,
      Map,
      Set,
      Error,
      TypeError,
      ...capGlobals,
      __finalAnswer__: undefined as unknown,
    });
  }

  async run(code: string, capabilities?: Partial<CapabilityManifest>): Promise<KernelResult> {
    if (this.#disposed) {
      throw new Error("KernelError: cannot run() on a disposed VmKernel");
    }
    this.#logs = [];
    this.#context.__finalAnswer__ = undefined;

    // Always clear capability globals first, then re-inject only what's granted.
    // This prevents capability leakage across successive run() calls.
    this.#context.fetch = undefined;
    this.#context.__fs__ = undefined;
    this.#context.__env__ = undefined;

    if (capabilities) {
      const capGlobals = buildCapabilityGlobals(capabilities);
      for (const [key, value] of Object.entries(capGlobals)) {
        this.#context[key] = value;
      }
    }

    // Per-call timeout: capability.cpuMs (if set) tightens the kernel default.
    const cpuMs = capabilities?.cpuMs;
    const effectiveTimeout =
      cpuMs != null && cpuMs > 0 ? Math.min(this.#timeoutMs, cpuMs) : this.#timeoutMs;

    const script = new Script(code, { filename: "agent-step.js" });
    let output: unknown;
    try {
      output = script.runInContext(this.#context, { timeout: effectiveTimeout });
    } catch (err) {
      throw new Error(`KernelError: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (
      output instanceof Promise ||
      (output !== null &&
        typeof output === "object" &&
        typeof (output as { then?: unknown }).then === "function")
    ) {
      output = await (output as Promise<unknown>);
    }

    const finalAnswer = this.#context.__finalAnswer__ as unknown;
    const isFinalAnswer = finalAnswer !== undefined;

    return {
      output: isFinalAnswer ? finalAnswer : output,
      logs: [...this.#logs],
      isFinalAnswer,
    };
  }

  async reset(): Promise<void> {
    this.#context = this.#createSandbox();
    this.#logs = [];
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#disposed = true;
    this.#logs = [];
  }
}
