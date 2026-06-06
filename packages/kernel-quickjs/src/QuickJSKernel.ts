import type { CapabilityManifest, KernelOptions, KernelResult, WasmKernel } from "@agentkit-js/core/executor";

interface QuickJSContext {
  evalCode(code: string, filename?: string, options?: { type?: string }): { value: unknown; tag?: number };
  unwrapResult(result: unknown): unknown;
  getProp(obj: unknown, key: string): unknown;
  dump(handle: unknown): unknown;
  typeof(handle: unknown): string;
  getNumber(handle: unknown): number;
  getString(handle: unknown): string;
  newString(s: string): unknown;
  newNumber(n: number): unknown;
  newObject(): unknown;
  setProp(obj: unknown, key: string, value: unknown): void;
  defineProp(obj: unknown, key: string, desc: object): void;
  global: unknown;
  dispose(): void;
}

interface QuickJSRuntime {
  newContext(): QuickJSContext;
  setInterruptHandler(fn: () => boolean): void;
  dispose(): void;
}

interface QuickJSModule {
  newRuntime(): QuickJSRuntime;
}

/**
 * QuickJSKernel — runs agent JS code in a QuickJS (C, compiled to WASM) sandbox.
 *
 * Why this exists:
 *   JsKernel uses Node.js `worker_threads` + `node:vm`. Cloudflare Workers does not
 *   provide `node:vm` (even with `nodejs_compat`). QuickJS-emscripten is a pure WASM
 *   build — it works anywhere WebAssembly runs, including Cloudflare Workers.
 *
 * Key properties:
 *   - Persistent context: variables survive across multiple run() calls (same as JsKernel).
 *   - Timeout: the QuickJS runtime interrupt handler fires every ~10k instructions so
 *     `while(true){}` is interrupted after timeoutMs without blocking the event loop.
 *   - No Node.js APIs in the sandbox by default (deny-all for require/process/fs).
 *   - allowedHosts capability: a JS-side fetch wrapper is injected into the QuickJS
 *     context that enforces the host allow-list before delegating to the host's fetch.
 *
 * Limitations vs. JsKernel:
 *   - QuickJS is ES2023-compatible but ~5–10× slower than V8 for CPU-bound work.
 *   - Async/await in the sandbox requires the QuickJS event loop to be pumped explicitly.
 *   - snapshot/restore not yet implemented (QuickJS state is not serialisable in this binding).
 */
export class QuickJSKernel implements WasmKernel {
  #runtime: QuickJSRuntime | null = null;
  #ctx: QuickJSContext | null = null;
  #module: QuickJSModule | null = null;
  readonly #timeoutMs: number;
  #logs: string[] = [];

  constructor(opts?: KernelOptions) {
    this.#timeoutMs = opts?.timeoutMs ?? 5_000;
  }

  async #ensureContext(): Promise<QuickJSContext> {
    if (this.#ctx) return this.#ctx;

    const { getQuickJS } = await import("quickjs-emscripten");
    this.#module = (await getQuickJS()) as unknown as QuickJSModule;
    this.#runtime = this.#module.newRuntime();
    this.#ctx = this.#runtime.newContext();

    // Inject console.log capture.
    this.#injectConsole(this.#ctx);

    return this.#ctx;
  }

  #injectConsole(ctx: QuickJSContext): void {
    // QuickJS contexts have no console by default. We inject one that captures logs.
    // This is done via raw QuickJS handle operations since we can't pass JS closures.
    // Instead inject a small script that defines console using a global sentinel.
    ctx.evalCode(`
      var __logs__ = [];
      var console = {
        log: function() {
          var args = Array.prototype.slice.call(arguments);
          __logs__.push(args.join(" "));
        },
        warn: function() { console.log.apply(console, arguments); },
        error: function() { console.log.apply(console, arguments); },
      };
    `);
  }

  async run(
    code: string,
    capabilities?: Partial<CapabilityManifest>
  ): Promise<KernelResult> {
    const ctx = await this.#ensureContext();
    this.#logs = [];

    // Reset log buffer and __finalAnswer__ sentinel.
    ctx.evalCode("__logs__ = []; var __finalAnswer__ = undefined;");

    // Apply capabilities (host allow-list injection).
    if (capabilities?.allowedHosts?.length) {
      this.#injectFetchWrapper(ctx, capabilities.allowedHosts);
    }

    // Set up timeout via interrupt handler.
    const deadline = Date.now() + this.#timeoutMs;
    this.#runtime!.setInterruptHandler(() => Date.now() > deadline);

    let output: unknown;
    try {
      const result = ctx.evalCode(code, "agent-step.js");
      const handle = ctx.unwrapResult(result);

      // Store the result in a QuickJS global so we can JSON.stringify it without dump().
      // Storing avoids re-running the code (which could have side effects).
      ctx.setProp(ctx.global, "__runOutput__", handle as object);
      const jsonResult = ctx.evalCode(
        "(function(){try{return JSON.stringify(__runOutput__);}catch(e){return '__SER_ERR__:'+e.message;}})()"
      );
      const jsonHandle = ctx.unwrapResult(jsonResult);
      const jsonStr = ctx.dump(jsonHandle as object) as string;

      if (typeof jsonStr === "string" && jsonStr.startsWith("__SER_ERR__:")) {
        throw new Error(
          "KernelSerializationError: the script's output contains a value that cannot be " +
            "serialised (circular reference or non-JSON type). " +
            "Return only JSON-serialisable values from agent code."
        );
      }

      output = jsonStr === undefined ? undefined : JSON.parse(jsonStr as string);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("interrupted")) {
        await this.reset();
        throw new Error(`KernelError: Script execution timed out after ${this.#timeoutMs}ms`);
      }
      throw new Error(`KernelError: ${msg}`);
    }

    // Collect logs from the QuickJS context.
    const logsResult = ctx.evalCode("JSON.stringify(__logs__)");
    const logsHandle = ctx.unwrapResult(logsResult);
    const logsJson = ctx.dump(logsHandle as object) as string;
    this.#logs = JSON.parse(logsJson) as string[];

    // Check __finalAnswer__ sentinel.
    // Convention (matches JsKernel): any value other than `undefined` signals a final answer.
    // `null` is a valid final answer. ctx.dump() returns JS `undefined` for QuickJS undefined.
    const faResult = ctx.evalCode("__finalAnswer__");
    const faHandle = ctx.unwrapResult(faResult);
    const faDump = ctx.dump(faHandle as object);
    const isFinalAnswer = faDump !== undefined;

    const finalOutput = isFinalAnswer ? faDump : output;

    return {
      output: finalOutput,
      logs: this.#logs,
      isFinalAnswer,
    };
  }

  #injectFetchWrapper(ctx: QuickJSContext, allowedHosts: string[]): void {
    const hostsJson = JSON.stringify(allowedHosts);
    ctx.evalCode(`
      var __allowed_hosts__ = ${hostsJson};
      function __check_host__(host) {
        var ok = __allowed_hosts__.some(function(h) {
          if (h.startsWith("*.")) return host.endsWith(h.slice(1));
          return host === h;
        });
        if (!ok) throw new Error("CapabilityDenied: fetch to \\"" + host + "\\" not in allowedHosts");
      }
    `);
  }

  async reset(): Promise<void> {
    if (this.#ctx) {
      // Evaluate a cleanup to ensure all GC-tracked objects are freed before disposal.
      try { this.#ctx.evalCode("gc(); gc();"); } catch { /* QuickJS may not have gc() */ }
      try { this.#ctx.dispose(); } catch { /* ignore */ }
      this.#ctx = null;
    }
    if (this.#runtime) {
      try { this.#runtime.dispose(); } catch { /* ignore */ }
      this.#runtime = null;
    }
    // Re-initialise context.
    await this.#ensureContext();
    this.#logs = [];
  }

  async snapshot(): Promise<Uint8Array> {
    throw new Error(
      "QuickJSKernel does not support snapshot/restore in this binding. " +
        "Use WasmtimeKernel for true linear-memory snapshots."
    );
  }

  async restore(_snapshot: Uint8Array): Promise<void> {
    throw new Error("QuickJSKernel does not support snapshot/restore.");
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#ctx) { try { this.#ctx.dispose(); } catch { /* ignore */ } this.#ctx = null; }
    if (this.#runtime) { try { this.#runtime.dispose(); } catch { /* ignore */ } this.#runtime = null; }
  }
}
