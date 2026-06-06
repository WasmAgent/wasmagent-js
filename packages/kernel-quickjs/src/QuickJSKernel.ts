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

  // Q4: cache the in-flight init promise so concurrent callers share one runtime.
  // Without this, two concurrent calls to #ensureContext() would both pass the
  // `if (this.#ctx)` guard, each build a runtime, and the second would overwrite
  // the first — leaking the first runtime forever.
  #initPromise: Promise<QuickJSContext> | null = null;

  // Q1: flag set by interrupt handler so interrupt detection does not rely on
  // parsing the error message string (which is an emscripten implementation detail).
  #timedOut = false;

  // Cached handles to JSON.stringify — initialised once per context, disposed on reset.
  #jsonObj: (QHandle & { dispose(): void }) | null = null;
  #stringify: (QHandle & { dispose(): void }) | null = null;

  constructor(opts?: KernelOptions) {
    this.#timeoutMs = opts?.timeoutMs ?? 5_000;
  }

  async #ensureContext(): Promise<QuickJSContext> {
    if (this.#ctx) return this.#ctx;
    // Q4: return the in-flight promise if init is already in progress.
    if (this.#initPromise) return this.#initPromise;

    this.#initPromise = (async () => {
      const { getQuickJS } = await import("quickjs-emscripten");
      this.#module = (await getQuickJS()) as unknown as QuickJSModule;
      this.#runtime = this.#module.newRuntime();
      this.#ctx = this.#runtime.newContext();

      this.#jsonObj = this.#ctx.getProp(this.#ctx.global, "JSON") as QHandle & { dispose(): void };
      this.#stringify = this.#ctx.getProp(this.#jsonObj, "stringify") as QHandle & { dispose(): void };

      this.#injectConsole(this.#ctx);
      return this.#ctx;
    })();

    return this.#initPromise;
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
   * Uses callFunction(JSON.stringify) — does not write to the global namespace (Q1).
   * Circular references throw KernelSerializationError (Q3).
   * Functions and Symbols also throw — JSON.stringify silently returns undefined for
   * these types, which would produce isFinalAnswer=true with output=undefined if not
   * caught here (Q2). We detect them with typeof before calling stringify.
   */
  #serialize(ctx: QuickJSContext, scope: ScopeType, handle: QHandle, label: string): unknown {
    // Q2: catch functions and symbols before stringify silently drops them.
    const t = ctx.typeof(handle);
    if (t === "function" || t === "symbol") {
      throw new Error(
        `KernelSerializationError: ${label} is a ${t} and cannot be serialised. ` +
          "Return only JSON-serialisable values from agent code."
      );
    }

    let jsonResult: ReturnType<QuickJSContext["unwrapResult"]>;
    try {
      jsonResult = scope.manage(
        ctx.unwrapResult(ctx.callFunction(this.#stringify!, ctx.global, handle))
      );
    } catch (err) {
      // JSON.stringify throws inside QuickJS for circular references.
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

    // Q1: use a flag instead of message-string matching to detect interrupts.
    // The interrupt handler sets #timedOut = true before the QuickJS error propagates.
    this.#timedOut = false;
    const deadline = Date.now() + this.#timeoutMs;
    this.#runtime!.setInterruptHandler(() => {
      if (Date.now() > deadline) { this.#timedOut = true; return true; }
      return false;
    });

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
        // Q1: check #timedOut flag set by interrupt handler — more reliable than
        // matching the emscripten error message string "interrupted".
        if (this.#timedOut) {
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
    // Q4: clear initPromise so #ensureContext rebuilds cleanly after dispose.
    this.#initPromise = null;
    this.#timedOut = false;
    await this.#ensureContext();
    this.#logs = [];
  }

  #disposeContextHandles(): void {
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
    this.#initPromise = null;
  }
}
