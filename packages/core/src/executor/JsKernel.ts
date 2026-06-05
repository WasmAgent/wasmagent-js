import { createContext, Script } from "node:vm";
import type {
  CapabilityManifest,
  KernelResult,
  WasmKernel,
} from "./types.js";

/**
 * M0 default kernel — runs JS code in an isolated Node.js vm context.
 *
 * State persists across run() calls (variables survive between steps).
 * Capability enforcement is host-side: forbidden built-ins are removed
 * from the sandbox context (deny-all baseline, A2).
 *
 * This is NOT a production security boundary — use WasmtimeKernel for
 * real sandboxing once M1 lands. JsKernel exists to make M0 development
 * fast without native dependencies.
 */
export class JsKernel implements WasmKernel {
  #context: ReturnType<typeof createContext>;
  #logs: string[] = [];

  constructor() {
    this.#context = this.#createSandbox();
  }

  #createSandbox(): ReturnType<typeof createContext> {
    const logCapture = (...args: unknown[]) => {
      this.#logs.push(args.map(String).join(" "));
    };

    return createContext({
      console: {
        log: logCapture,
        warn: logCapture,
        error: logCapture,
      },
      // Deny dangerous globals by omission (A2 deny-all baseline).
      // fetch, fs, require, process are NOT included.
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
      // Sentinel set by agent code to signal a final answer.
      __finalAnswer__: undefined as unknown,
    });
  }

  async run(
    code: string,
    _capabilities?: Partial<CapabilityManifest>
  ): Promise<KernelResult> {
    this.#logs = [];
    this.#context["__finalAnswer__"] = undefined;

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
    // JsKernel uses JSON serialisation as a simple snapshot mechanism.
    // WasmtimeKernel will use true linear-memory snapshots (A1).
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
