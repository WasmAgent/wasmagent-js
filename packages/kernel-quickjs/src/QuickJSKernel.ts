import type {
  CapabilityManifest,
  KernelOptions,
  KernelResult,
  WasmKernel,
} from "@agentkit-js/core/executor";

// We import Scope for RAII handle management (Q5).
// QuickJS handle types are opaque objects — we use 'object' throughout.
type QHandle = object;

interface QuickJSContext {
  evalCode(code: string, filename?: string): { value: unknown; tag?: number; dispose?(): void };
  unwrapResult(
    result: unknown
  ): { consume<T>(fn: (h: QHandle) => T): T; dispose(): void } & QHandle;
  callFunction(fn: unknown, thisVal: unknown, ...args: unknown[]): { value: unknown; tag?: number };
  getProp(
    obj: unknown,
    key: string
  ): { consume<T>(fn: (h: QHandle) => T): T; dispose(): void } & QHandle;
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
  hasPendingJob(): boolean;
  executePendingJobs(maxJobs?: number): unknown;
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
 * Q3 — Cloudflare Workers compatibility:
 *   Workers prohibits runtime WASM compilation (same restriction as eval). The default
 *   `getQuickJS()` from quickjs-emscripten fetches and compiles a .wasm at runtime,
 *   which crashes in workerd with CompileError: WebAssembly code generation disallowed.
 *
 *   The fix: pass a pre-compiled variant via the `variant` option. In the Cloudflare
 *   Worker, import the variant at build time and inject it:
 *
 *     import cfVariant from "@jitl/quickjs-wasmfile-release-sync";
 *     import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
 *     new QuickJSKernel({ variant: cfVariant, variantLoader: newQuickJSWASMModuleFromVariant })
 *
 *   The variant is bundled by wrangler at build time, so no runtime WASM compilation
 *   is needed. Node environments can omit variant/variantLoader and use the default.
 */
export interface QuickJSKernelOptions extends KernelOptions {
  /**
   * Pre-compiled QuickJS variant for environments that prohibit runtime WASM
   * compilation (Cloudflare Workers). Must be paired with variantLoader.
   * Omit to use the default getQuickJS() which compiles at runtime (Node only).
   */
  variant?: unknown;
  /**
   * Loader function for the pre-compiled variant, e.g.
   * `newQuickJSWASMModuleFromVariant` from "quickjs-emscripten-core".
   */
  variantLoader?: (variant: unknown) => Promise<QuickJSModule>;
}

export class QuickJSKernel implements WasmKernel {
  #runtime: QuickJSRuntime | null = null;
  #ctx: QuickJSContext | null = null;
  #module: QuickJSModule | null = null;
  readonly #timeoutMs: number;
  readonly #variant: unknown;
  readonly #variantLoader: ((v: unknown) => Promise<QuickJSModule>) | undefined;
  #logs: string[] = [];

  // Q4: cache the in-flight init promise so concurrent callers share one runtime.
  #initPromise: Promise<QuickJSContext> | null = null;

  // Q1: flag set by interrupt handler so interrupt detection does not rely on
  // parsing the error message string (which is an emscripten implementation detail).
  #timedOut = false;

  // Cached handles to JSON.stringify — initialised once per context, disposed on reset.
  #jsonObj: (QHandle & { dispose(): void }) | null = null;
  #stringify: (QHandle & { dispose(): void }) | null = null;

  constructor(opts?: QuickJSKernelOptions) {
    this.#timeoutMs = opts?.timeoutMs ?? 5_000;
    this.#variant = opts?.variant;
    this.#variantLoader = opts?.variantLoader;
  }

  async #ensureContext(): Promise<QuickJSContext> {
    if (this.#ctx) return this.#ctx;
    // Q4: return the in-flight promise if init is already in progress.
    if (this.#initPromise) return this.#initPromise;

    this.#initPromise = (async () => {
      if (this.#variant && this.#variantLoader) {
        // Q3: Workers-safe path — use pre-compiled variant (no runtime WASM compilation).
        this.#module = await this.#variantLoader(this.#variant);
      } else {
        // Default Node.js path — getQuickJS() fetches and compiles .wasm at runtime.
        // This will fail in Cloudflare Workers (WASM compilation is disallowed).
        const { getQuickJS } = await import("quickjs-emscripten");
        this.#module = (await getQuickJS()) as unknown as QuickJSModule;
      }
      this.#runtime = this.#module.newRuntime();
      this.#ctx = this.#runtime.newContext();

      this.#jsonObj = this.#ctx.getProp(this.#ctx.global, "JSON") as QHandle & { dispose(): void };
      this.#stringify = this.#ctx.getProp(this.#jsonObj, "stringify") as QHandle & {
        dispose(): void;
      };

      this.#injectConsole(this.#ctx);
      return this.#ctx;
    })();

    return this.#initPromise;
  }

  #injectConsole(ctx: QuickJSContext): void {
    const result = ctx.evalCode(`
      var __logs__ = [];
      var console = {
        log: function() { __logs__.push(Array.prototype.join.call(arguments, " ")); },
        warn: function() { console.log.apply(console, arguments); },
        error: function() { console.log.apply(console, arguments); },
      };
    `);
    if (result && typeof (result as { dispose?: () => void }).dispose === "function") {
      (result as { dispose: () => void }).dispose();
    }
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
        ctx.unwrapResult(
          ctx.callFunction(this.#stringify as QHandle & { dispose(): void }, ctx.global, handle)
        )
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

  async run(code: string, capabilities?: Partial<CapabilityManifest>): Promise<KernelResult> {
    const ctx = await this.#ensureContext();
    const { Scope } = await import("quickjs-emscripten");
    const ScopeStatic = Scope as unknown as ScopeStatic;
    this.#logs = [];

    ctx
      .evalCode("__logs__ = []; var __finalAnswer__ = undefined; var __final_answer__ = undefined;")
      ?.dispose?.();

    if (capabilities?.allowedHosts?.length) {
      this.#injectFetchWrapper(ctx, capabilities.allowedHosts);
    }

    // Code-mode unified policy face (S1/A1, 2026-06): env injection mirrors
    // buildCapabilityGlobals so the same manifest yields the same `__env__`
    // surface in QuickJS as in JsKernel/VmKernel.
    if (capabilities?.env && Object.keys(capabilities.env).length > 0) {
      this.#injectEnv(ctx, capabilities.env);
    }
    // Memory limit: QuickJS exposes a hard runtime cap. We only honour the
    // *lower* of the constructor default and the per-call request — never widen.
    if (capabilities?.memoryLimitBytes && capabilities.memoryLimitBytes > 0 && this.#runtime) {
      try {
        // setMemoryLimit is available on QuickJSRuntime; -1 disables the limit.
        // Cast through unknown so we don't depend on a specific quickjs-emscripten
        // type version exposing the method on its public surface.
        const rt = this.#runtime as unknown as { setMemoryLimit?: (n: number) => void };
        rt.setMemoryLimit?.(capabilities.memoryLimitBytes);
      } catch {
        // Best effort — older quickjs-emscripten builds did not export the helper.
      }
    }

    // Q1: use a flag instead of message-string matching to detect interrupts.
    // The interrupt handler sets #timedOut = true before the QuickJS error propagates.
    this.#timedOut = false;
    // Per-call timeout: cpuMs (if set) tightens the kernel default; never widens.
    const cpuMs = capabilities?.cpuMs;
    const effectiveTimeout =
      cpuMs != null && cpuMs > 0 ? Math.min(this.#timeoutMs, cpuMs) : this.#timeoutMs;
    const deadline = Date.now() + effectiveTimeout;
    this.#runtime?.setInterruptHandler(() => {
      if (Date.now() > deadline) {
        this.#timedOut = true;
        return true;
      }
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

      // Q2/Q5: check both sentinels — camelCase (__finalAnswer__) and snake_case (__final_answer__).
      // Both spellings are initialised to undefined above; whichever the agent sets is used.
      // This lets agent code work regardless of which kernel backend (JS vs Python convention).
      const faCamelHandle = scope.manage(ctx.unwrapResult(ctx.evalCode("__finalAnswer__")));
      const faSnakeHandle = scope.manage(ctx.unwrapResult(ctx.evalCode("__final_answer__")));
      const faCamelSet = ctx.typeof(faCamelHandle as QHandle) !== "undefined";
      const faSnakeSet = ctx.typeof(faSnakeHandle as QHandle) !== "undefined";
      isFinalAnswer = faCamelSet || faSnakeSet;
      const faHandle = faCamelSet ? faCamelHandle : faSnakeHandle;

      let finalOutput = output;
      if (isFinalAnswer) {
        finalOutput = this.#serialize(ctx, scope, faHandle as QHandle, "__finalAnswer__");
      }

      return { output: finalOutput, logs: this.#logs, isFinalAnswer };
    });
  }

  #injectFetchWrapper(ctx: QuickJSContext, allowedHosts: string[]): void {
    const hostsJson = JSON.stringify(allowedHosts);
    ctx
      .evalCode(`
      var __allowed_hosts__ = ${hostsJson};
      function __check_host__(host) {
        var ok = __allowed_hosts__.some(function(h) {
          if (h.startsWith("*.")) return host.endsWith(h.slice(1));
          return host === h;
        });
        if (!ok) throw new Error("CapabilityDenied: fetch to \\"" + host + "\\" not in allowedHosts");
      }
    `)
      ?.dispose?.();
  }

  /**
   * Inject the unified `__env__` global (S1/A1 code-mode policy face).
   * The map is JSON-stringified into the QuickJS context and frozen so
   * sandbox code cannot mutate it. Mirrors `buildCapabilityGlobals` from core.
   */
  #injectEnv(ctx: QuickJSContext, env: Readonly<Record<string, string>>): void {
    const envJson = JSON.stringify(env);
    ctx
      .evalCode(`
      var __env__ = Object.freeze(${envJson});
    `)
      ?.dispose?.();
  }

  async reset(): Promise<void> {
    this.#disposeContextHandles();
    this.#drainPendingJobs();
    if (this.#ctx) {
      try {
        this.#ctx.dispose();
      } catch {
        /* ignore */
      }
      this.#ctx = null;
    }
    // After an interrupt/timeout, the QuickJS runtime may have live GC objects
    // that cause a native assertion if we call runtime.dispose(). Skip dispose
    // in that case and let the WASM module clean up when the process exits.
    if (this.#runtime && !this.#timedOut) {
      try {
        this.#runtime.dispose();
      } catch {
        /* ignore */
      }
    }
    this.#runtime = null;
    // Q4: clear initPromise so #ensureContext rebuilds cleanly after dispose.
    this.#initPromise = null;
    this.#timedOut = false;
    await this.#ensureContext();
    this.#logs = [];
  }

  #disposeContextHandles(): void {
    if (this.#stringify) {
      try {
        this.#stringify.dispose();
      } catch {
        /* ignore */
      }
      this.#stringify = null;
    }
    if (this.#jsonObj) {
      try {
        this.#jsonObj.dispose();
      } catch {
        /* ignore */
      }
      this.#jsonObj = null;
    }
  }

  /** Drain any pending QuickJS microjobs before disposing runtime to prevent GC assertion failures. */
  #drainPendingJobs(): void {
    if (!this.#runtime) return;
    try {
      while (this.#runtime.hasPendingJob()) {
        this.#runtime.executePendingJobs(1);
      }
    } catch {
      /* ignore errors from aborted/interrupted scripts */
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#disposeContextHandles();
    this.#drainPendingJobs();
    if (this.#ctx) {
      try {
        this.#ctx.dispose();
      } catch {
        /* ignore */
      }
      this.#ctx = null;
    }
    if (this.#runtime && !this.#timedOut) {
      try {
        this.#runtime.dispose();
      } catch {
        /* ignore */
      }
    }
    this.#runtime = null;
    this.#initPromise = null;
  }
}
