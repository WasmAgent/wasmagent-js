import { createContext, Script } from "node:vm";
import type { CapabilityManifest, KernelOptions, KernelResult, WasmKernel } from "./types.js";
import { buildCapabilityGlobals } from "./capabilities.js";

/**
 * V8WasmKernel — pure-JS fallback using Node's vm module.
 *
 * Designed to be serverless-safe (no native deps) and compatible with
 * Cloudflare Workers and AWS Lambda. Capability enforcement mirrors JsKernel
 * (A2 deny-all baseline with per-call allow-list injection).
 */
export class V8WasmKernel implements WasmKernel {
  #context: ReturnType<typeof createContext>;
  #logs: string[] = [];
  readonly #timeoutMs: number | undefined;

  constructor(opts?: KernelOptions) {
    this.#timeoutMs = opts?.timeoutMs;
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

  async run(
    code: string,
    capabilities?: Partial<CapabilityManifest>
  ): Promise<KernelResult> {
    this.#logs = [];
    this.#context["__finalAnswer__"] = undefined;

    // Always clear capability globals first, then re-inject only what's granted.
    // This prevents capability leakage across successive run() calls: a call that
    // grants fetch/fs cannot silently leave those globals available to the next call.
    // Use assignment to undefined rather than delete — delete on a non-configurable
    // property silently fails, while assignment always takes effect.
    this.#context["fetch"] = undefined;
    this.#context["__fs__"] = undefined;

    if (capabilities) {
      const capGlobals = buildCapabilityGlobals(capabilities);
      for (const [key, value] of Object.entries(capGlobals)) {
        this.#context[key] = value;
      }
    }

    const script = new Script(code, { filename: "agent-step.js" });
    let output: unknown;
    try {
      const runOpts = this.#timeoutMs ? { timeout: this.#timeoutMs } : {};
      output = script.runInContext(this.#context, runOpts);
    } catch (err) {
      throw new Error(
        `KernelError: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Await any Promise the code returned, mirroring JsKernelWorker behavior so
    // async code and async __finalAnswer__ assignments work on the edge path too.
    if (
      output instanceof Promise ||
      (output !== null && typeof output === "object" &&
        typeof (output as { then?: unknown }).then === "function")
    ) {
      output = await (output as Promise<unknown>);
    }

    const finalAnswer = this.#context["__finalAnswer__"] as unknown;
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
    // Drop references; GC reclaims the vm.Context.
    this.#logs = [];
  }
}
