import { createContext, Script } from "node:vm";
import type {
  CapabilityManifest,
  KernelOptions,
  KernelResult,
  WasmKernel,
} from "./types.js";
import { buildCapabilityGlobals } from "./capabilities.js";

/**
 * Default JS kernel — runs JS code in an isolated Node.js vm context.
 *
 * State persists across run() calls (variables survive between steps).
 * Capability enforcement is host-side: forbidden built-ins are removed
 * from the sandbox context (A2 deny-all baseline). Permitted capabilities
 * (allowedHosts, allowedReadPaths, allowedWritePaths) are injected per-call.
 *
 * This is NOT a production security boundary — use WasmtimeKernel (M1+)
 * for real WASM sandboxing when the native addon is available.
 */
export class JsKernel implements WasmKernel {
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
      // Deny dangerous globals by omission (A2 deny-all baseline).
      // fetch, fs, require, process are NOT included unless explicitly granted.
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
      // Capability-gated globals (A2): only present when the manifest allows them.
      ...capGlobals,
      // Sentinel set by agent code to signal a final answer.
      __finalAnswer__: undefined as unknown,
    });
  }

  async run(
    code: string,
    capabilities?: Partial<CapabilityManifest>
  ): Promise<KernelResult> {
    this.#logs = [];
    this.#context["__finalAnswer__"] = undefined;

    // Re-inject capability globals for this call (A2 per-call enforcement).
    if (capabilities) {
      const capGlobals = buildCapabilityGlobals(capabilities);
      for (const [key, value] of Object.entries(capGlobals)) {
        this.#context[key] = value;
      }
    }

    const script = new Script(code, { filename: "agent-step.js" });
    let output: unknown;
    try {
      // timeout blocks synchronous infinite loops (while/for with no awaits).
      // It does NOT stop async busy-loops — use Worker-thread isolation for those.
      const runOpts = this.#timeoutMs ? { timeout: this.#timeoutMs } : {};
      output = script.runInContext(this.#context, runOpts);
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
    // JSON serialisation silently drops functions, Maps, Sets, and closures.
    // A caller that snapshots → resets → restores would get a silently broken state.
    // Real byte-exact snapshot/restore requires WasmtimeKernel (A1 M1+).
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
    await this.reset();
  }
}
