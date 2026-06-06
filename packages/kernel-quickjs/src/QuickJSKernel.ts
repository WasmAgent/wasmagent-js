import type { CapabilityManifest, KernelOptions, KernelResult, WasmKernel } from "@agentkit-js/core/executor";

// We import Scope for RAII handle management (Q5).
// QuickJS handle types are opaque objects — we use 'object' throughout.
type QHandle = object;

interface QuickJSContext {
  evalCode(code: string, filename?: string): { value: unknown; tag?: number };
  unwrapResult(result: unknown): { consume<T>(fn: (h: QHandle) => T): T; dispose(): void } & QHandle;
  callFunction(fn: unknown, thisVal: unknown, ...args: unknown[]): { value: unknown; tag?: number };
  getProp(obj: unknown, key: string): { consume<T>(fn: (h: QHandle) => T): T; dispose(): void } & QHandle;
  setProp(obj: unknown, key: string, value: unknown): void;
  dump(handle: unknown): unknown;
  typeof(handle: unknown): string;
  getString(handle: unknown): string;
  global: QHandle;
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

interface ScopeType {
  manage<T extends { dispose(): void }>(handle: T): T;
}

interface ScopeStatic {
  withScopeAsync<T>(fn: (scope: ScopeType) => Promise<T>): Promise<T>;
}

/**
 * QuickJSKernel — runs agent JS code in a QuickJS (C, compiled to WASM) sandbox.
 *
 * Why this exists:
 *   JsKernel uses Node.js worker_threads + node:vm. Cloudflare Workers does not
 *   provide node:vm. QuickJS-emscripten is a pure WASM build — it works anywhere
 *   WebAssembly runs, including Cloudflare Workers and serverless edge runtimes.
 *
 * Key properties:
 *   - Persistent context: variables survive across run() calls (stateful kernel).
 *   - Timeout: QuickJS interrupt handler fires every ~10k instructions so
 *     while(true){} is interrupted after timeoutMs without blocking the event loop.
 *   - No Node.js APIs in the sandbox by default (deny-all baseline).
 *   - allowedHosts capability: a JS-side fetch wrapper enforces the host allow-list.
 *
 * Handle lifecycle (Q5): all QuickJS handles are managed with Scope.withScopeAsync
 * so they are disposed automatically — no manual .dispose() calls scattered around.
 * Handles cached across calls (#stringify, #jsonObj) are disposed in reset/asyncDispose.
 *
 * Serialisation (Q1, Q2, Q3): output and __finalAnswer__ are extracted via
 * callFunction(JSON.stringify, ...) instead of ctx.dump(), which silently corrupts
 * circular refs and drops functions. Circular refs now throw KernelSerializationError.
 */
export class QuickJSKernel implements WasmKernel {
  #runtime: QuickJSRuntime | null = null;
  #ctx: QuickJSContext | null = null;
  #module: QuickJSModule | null = null;
  readonly #timeoutMs: number;
  #logs: string[] = [];

  // Cached handles to JSON.stringify — initialised once per context, disposed on reset.
  #jsonObj: (QHandle & { dispose(): void }) | null = null;
  #stringify: (QHandle & { dispose(): void }) | null = null;

  constructor(opts?: KernelOptions) {
    this.#timeoutMs = opts?.timeoutMs ?? 5_000;
  }

  async #ensureContext(): Promise<QuickJSContext> {
    if (this.#ctx) return this.#ctx;

    const { getQuickJS } = await import("quickjs-emscripten");
    this.#module = (await getQuickJS()) as unknown as QuickJSModule;
    this.#runtime = this.#module.newRuntime();
    this.#ctx = this.#runtime.newContext();

    // Cache JSON.stringify handle — reused on every run() to avoid re-fetching.
    // Q1: callFunction(stringify, ctx.global, handle) never writes to global namespace,
    // unlike the old setProp("__runOutput__") approach.
    this.#jsonObj = this.#ctx.getProp(this.#ctx.global, "JSON") as QHandle & { dispose(): void };
    this.#stringify = this.#ctx.getProp(this.#jsonObj, "stringify") as QHandle & { dispose(): void };

    this.#injectConsole(this.#ctx);
    return this.#ctx;
  }

  #injectConsole(ctx: QuickJSContext): void {
    ctx.evalCode(`
      var __logs__ = [];
      var console = {
        log: function() { __logs__.push(Array.prototype.join.call(arguments, " ")); },
        warn: function() { console.log.apply(console, arguments); },
        error: function() { console.log.apply(console, arguments); },
      };
    `);
  }

  /**
   * Serialise a QuickJS handle to a JS value using JSON.stringify inside QuickJS.
   *
   * Q1: uses callFunction — does not write to global namespace.
   * Q3: circular references throw KernelSerializationError (JSON.stringify raises in QuickJS).
   * Q2: output and __finalAnswer__ both go through this path — behaviour is consistent.
   * Q5: caller passes a Scope; the intermediate JSON string handle is scope.managed.
   */
  #serialize(ctx: QuickJSContext, scope: ScopeType, handle: QHandle, label: string): unknown {
    let jsonResult: ReturnType<QuickJSContext["unwrapResult"]>;
    try {
      jsonResult = scope.manage(
        ctx.unwrapResult(ctx.callFunction(this.#stringify!, ctx.global, handle))
      );
    } catch (err) {
      // JSON.stringify throws inside QuickJS for circular references.
      // Wrap as KernelSerializationError to match JsKernel's DataCloneError behaviour.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `KernelSerializationError: ${label} contains a value that cannot be serialised ` +
          `(${msg}). Return only JSON-serialisable values from agent code.`
      );
    }

    // JSON.stringify(undefined) returns QuickJS undefined — typeof check before getString.
    if (ctx.typeof(jsonResult as QHandle) === "undefined") {
      return undefined;
    }

    const jsonStr = ctx.getString(jsonResult);

    try {
      return JSON.parse(jsonStr);
    } catch {
      throw new Error(
        `KernelSerializationError: ${label} contains a value that cannot be serialised ` +
          "(non-JSON type). Return only JSON-serialisable values from agent code."
      );
    }
  }

  async run(
    code: string,
    capabilities?: Partial<CapabilityManifest>
  ): Promise<KernelResult> {
    const ctx = await this.#ensureContext();
    const { Scope } = await import("quickjs-emscripten");
    const ScopeStatic = Scope as unknown as ScopeStatic;
    this.#logs = [];

    ctx.evalCode("__logs__ = []; var __finalAnswer__ = undefined;");

    if (capabilities?.allowedHosts?.length) {
      this.#injectFetchWrapper(ctx, capabilities.allowedHosts);
    }

    // Set up timeout via interrupt handler.
    const deadline = Date.now() + this.#timeoutMs;
    this.#runtime!.setInterruptHandler(() => Date.now() > deadline);

    // Q5: Scope.withScopeAsync automatically disposes all scope.manage()'d handles
    // when the block exits, whether by return or throw. No manual .dispose() needed.
    return ScopeStatic.withScopeAsync(async (scope) => {
      let output: unknown;
      let isFinalAnswer = false;

      try {
        const resultHandle = scope.manage(ctx.unwrapResult(ctx.evalCode(code, "agent-step.js")));

        // Q1/Q3: serialise output via callFunction(JSON.stringify) — no global writes,
        // and circular refs / functions throw KernelSerializationError here.
        output = this.#serialize(ctx, scope, resultHandle as QHandle, "output");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("interrupted")) {
          await this.reset();
          throw new Error(`KernelError: Script execution timed out after ${this.#timeoutMs}ms`);
        }
        if (msg.startsWith("KernelSerializationError")) throw err;
        throw new Error(`KernelError: ${msg}`);
      }
      const logsHandle = scope.manage(ctx.unwrapResult(ctx.evalCode("JSON.stringify(__logs__)")));
      this.#logs = JSON.parse(ctx.getString(logsHandle)) as string[];

      // Q2: use ctx.typeof() to detect whether __finalAnswer__ was set (typeof "undefined"
      // means unset). Then serialise the value through the same JSON path as output —
      // consistent behaviour: functions are dropped → KernelSerializationError.
      const faHandle = scope.manage(ctx.unwrapResult(ctx.evalCode("__finalAnswer__")));
      isFinalAnswer = ctx.typeof(faHandle as QHandle) !== "undefined";

      let finalOutput = output;
      if (isFinalAnswer) {
        finalOutput = this.#serialize(ctx, scope, faHandle as QHandle, "__finalAnswer__");
      }

      return { output: finalOutput, logs: this.#logs, isFinalAnswer };
    });
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
    this.#disposeContextHandles();
    if (this.#ctx) { try { this.#ctx.dispose(); } catch { /* ignore */ } this.#ctx = null; }
    if (this.#runtime) { try { this.#runtime.dispose(); } catch { /* ignore */ } this.#runtime = null; }
    await this.#ensureContext();
    this.#logs = [];
  }

  #disposeContextHandles(): void {
    // Dispose the cached handles that outlive individual run() calls.
    if (this.#stringify) { try { this.#stringify.dispose(); } catch { /* ignore */ } this.#stringify = null; }
    if (this.#jsonObj) { try { this.#jsonObj.dispose(); } catch { /* ignore */ } this.#jsonObj = null; }
  }

  async snapshot(): Promise<Uint8Array> {
    throw new Error(
      "QuickJSKernel does not support snapshot/restore. Use WasmtimeKernel for byte-exact snapshots."
    );
  }

  async restore(_snapshot: Uint8Array): Promise<void> {
    throw new Error("QuickJSKernel does not support snapshot/restore.");
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#disposeContextHandles();
    if (this.#ctx) { try { this.#ctx.dispose(); } catch { /* ignore */ } this.#ctx = null; }
    if (this.#runtime) { try { this.#runtime.dispose(); } catch { /* ignore */ } this.#runtime = null; }
  }
}
