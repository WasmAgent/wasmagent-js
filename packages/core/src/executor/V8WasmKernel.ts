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

  constructor(_opts?: KernelOptions) {
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

    if (capabilities) {
      const capGlobals = buildCapabilityGlobals(capabilities);
      for (const [key, value] of Object.entries(capGlobals)) {
        this.#context[key] = value;
      }
    }

    const script = new Script(code, { filename: "agent-step.js" });
    let output: unknown;
    try {
      output = script.runInContext(this.#context);
    } catch (err) {
      throw new Error(
        `KernelError: ${err instanceof Error ? err.message : String(err)}`
      );
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

  async snapshot(): Promise<Uint8Array> {
    const state = JSON.stringify(this.#context);
    return new TextEncoder().encode(state);
  }

  async restore(snapshot: Uint8Array): Promise<void> {
    const state = JSON.parse(new TextDecoder().decode(snapshot)) as Record<
      string,
      unknown
    >;
    this.#context = createContext(state);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.reset();
  }
}
