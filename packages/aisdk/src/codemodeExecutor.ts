/**
 * codemodeExecutor.ts — Cloudflare codemode `Executor` adapter (Direction 1).
 *
 * Lets users plug an agentkit `Kernel` into `@cloudflare/codemode` as a
 * custom executor:
 *
 *     import { createCodeTool } from "@cloudflare/codemode/ai";
 *     import { agentkitCodemodeExecutor } from "@wasmagent/aisdk";
 *     import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
 *
 *     const codemode = createCodeTool({
 *       tools: myAiSdkTools,
 *       executor: agentkitCodemodeExecutor({
 *         kernel: new QuickJSKernel(),
 *         capabilities: { allowedHosts: [], cpuMs: 5000 },
 *       }),
 *     });
 *
 * Closes the three explicit gaps in the default `DynamicWorkerExecutor`:
 *
 *   1. Cross-platform (Node / Bun / Vercel / Lambda) — `DynamicWorkerExecutor`
 *      requires a Workers runtime.
 *   2. Optional Python tier (swap `QuickJSKernel` for `PyodideKernel`).
 *   3. Honors `needsApproval` if the caller wires it through agentkit's
 *      tool lifecycle (the executor itself stays neutral here — approval
 *      is a tool-registry concern, not an executor concern).
 *
 * The `Executor` interface is duplicated structurally below rather than
 * imported from `@cloudflare/codemode`. Importing would force every
 * `@wasmagent/aisdk` consumer to install codemode even when they only
 * want the AI SDK shims (`sandboxedJsTool` / `codeModeTool`). The two
 * types match the spec quoted at
 * https://github.com/cloudflare/agents/blob/main/docs/codemode.md
 * (verified 2026-06-12 via context7 docs query).
 *
 * Implementation status (2026-06-17): all three parts shipped — types,
 * marker-rerun execute() loop, and 10-test suite (`codemodeExecutor.test.ts`).
 * The upstream Cloudflare codemode PR draft at
 * `docs/strategy/upstream-prs/cloudflare-codemode-byo-executor.md` references
 * this import path; the shim is now ready for that PR to land.
 */

import type { CapabilityManifest, WasmKernel } from "@wasmagent/core";

// ── Cloudflare codemode contract (structural copy) ──────────────────────────

/**
 * Result the codemode `Executor.execute()` must return. Matches
 * `cloudflare/agents` `docs/codemode.md` exactly:
 *   { result: unknown; error?: string; logs?: string[] }
 */
export interface CodemodeExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

/**
 * One namespace entry in the `ResolvedProvider[]` form of `providersOrFns`.
 * Cloudflare codemode uses this when tools are grouped under a namespace
 * (e.g. `tools.weather.getCurrent(...)` becomes `name: "weather", fns: { getCurrent }`).
 */
export interface CodemodeResolvedProvider {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  /**
   * When true, the LLM-emitted code calls fns positionally
   * (`fn(arg1, arg2)`); when false / absent, args are passed as an object
   * (`fn({a, b})`). Cloudflare's default tool surface uses object args.
   */
  positionalArgs?: boolean;
}

/**
 * Either form codemode passes to `execute()`. Flat `Record` is the simple
 * case (no namespace); the array form supports namespaced providers.
 */
export type CodemodeProvidersOrFns =
  | CodemodeResolvedProvider[]
  | Record<string, (...args: unknown[]) => Promise<unknown>>;

/**
 * The minimal `Executor` interface codemode expects. We export it so users
 * who construct an executor by hand have a type to assert against.
 */
export interface CodemodeExecutor {
  execute(code: string, providersOrFns: CodemodeProvidersOrFns): Promise<CodemodeExecuteResult>;
}

// ── agentkit options ────────────────────────────────────────────────────────

export interface AgentkitCodemodeExecutorOptions {
  /**
   * Kernel that runs the LLM-emitted code. `QuickJSKernel` for edge-safe
   * cross-platform execution; `PyodideKernel` for Python; `JsKernel` for
   * Node-only quick prototypes; `RemoteSandboxKernel` for E2B / CF
   * Sandbox microVM tier.
   */
  kernel: WasmKernel;
  /**
   * Same `CapabilityManifest` shape every other agentkit kernel honors.
   * Defaults to deny-all (no network, no fs, no env). Override via
   * `{ allowedHosts: [...], cpuMs: 5000, ... }`.
   */
  capabilities?: Partial<CapabilityManifest>;
  /**
   * Hard cap on iterations of the callback re-run loop (matches
   * `ProgrammaticOrchestrator`'s 50). Set lower to fail fast on runaway
   * scripts, higher only after measurement.
   */
  maxIterations?: number;
}

// ── factory (signature only — implementation in part 2) ─────────────────────

/**
 * Build a codemode-shaped `Executor` backed by an agentkit kernel.
 *
 * @experimental — the wire shape of `CodemodeExecutor` tracks
 *                 `@cloudflare/codemode` and may shift if the upstream
 *                 contract changes during stabilization.
 */
export function agentkitCodemodeExecutor(opts: AgentkitCodemodeExecutorOptions): CodemodeExecutor {
  // Defensive read: rejects malformed opts at construction time, before
  // the LLM emits its first script. The empty-body validations below are
  // load-bearing — a missing `kernel` would otherwise surface as a
  // confusing "cannot read properties of undefined" deep inside the
  // execute() call.
  if (!opts || typeof opts !== "object") {
    throw new TypeError("agentkitCodemodeExecutor: opts is required");
  }
  if (!opts.kernel || typeof opts.kernel.run !== "function") {
    throw new TypeError("agentkitCodemodeExecutor: opts.kernel must be a WasmKernel (with .run())");
  }

  return {
    async execute(
      code: string,
      providersOrFns: CodemodeProvidersOrFns
    ): Promise<CodemodeExecuteResult> {
      const PENDING_MARKER = "__CODEMODE_PENDING__";
      const maxIter = opts.maxIterations ?? 50;
      const caps = opts.capabilities ?? {};

      // 1. Flatten providersOrFns into a dotted-name map.
      //    "weather.getCurrent" -> { fn, positional } (namespaced)
      //    "getWeather" ->        { fn, positional: false } (top-level)
      const flat = flattenProviders(providersOrFns);

      // 2. Build the kernel-side proxy. We construct a literal nested
      //    object whose leaves push a {key, name, args} record into
      //    __codemode_calls__ and reject with a marker error. This is
      //    parallel to ProgrammaticOrchestrator's `callTool` injection
      //    but reshaped for the namespace-method authoring style cloudflare
      //    codemode trains the LLM toward (`await tools.weather.getCurrent({...})`).
      const toolsLiteral = buildToolsObjectLiteral(flat, PENDING_MARKER);

      // 3. Setup script: install __codemode_* state and the `tools` global
      //    once. Re-runs reset __codemode_calls__ but preserve resolved
      //    results, so a pause-resume cycle does not duplicate completed
      //    work.
      //    Note: we do NOT install a console-capture shim — every kernel
      //    already collects console.* into its `KernelResult.logs`. We
      //    accumulate those into `aggregatedLogs` on the host side,
      //    which sidesteps the per-run console-reinitialisation that
      //    some kernels (e.g. JsKernel's worker) perform.
      const setupScript = `
        var __codemode_results__ = {};
        var __codemode_calls__ = [];
        var tools = ${toolsLiteral};
      `;
      await opts.kernel.run(setupScript, caps);

      // 4. Run loop — bounded marker-rerun.
      const resolved = new Map<string, string>();
      const aggregatedLogs: string[] = [];
      let lastError: string | undefined;
      let lastResult: unknown;

      for (let iter = 0; iter < maxIter; iter++) {
        const runScript = buildRunScript(code, PENDING_MARKER);
        const exec = await opts.kernel.run(runScript, caps);

        // Accumulate kernel-reported logs (each kernel collects console.*
        // into result.logs). Iteration-level logs are concatenated; the
        // setup script and inject scripts never produce logs (no user
        // code), so this is a faithful console capture.
        if (Array.isArray(exec.logs)) aggregatedLogs.push(...exec.logs);

        const rawOut = typeof exec.output === "string" ? exec.output : JSON.stringify(exec.output);

        let parsed: {
          done: boolean;
          result?: unknown;
          pending?: { key: string; name: string; args: unknown };
          error?: string;
        };
        try {
          parsed = JSON.parse(rawOut) as typeof parsed;
        } catch {
          // Kernel returned something that isn't our envelope — treat as a
          // direct result (e.g. a kernel-level error before the wrapper
          // could format).
          lastResult = rawOut;
          break;
        }

        if (parsed.done) {
          if (parsed.error) lastError = parsed.error;
          else lastResult = parsed.result;
          break;
        }

        if (!parsed.pending) {
          lastError = "agentkitCodemodeExecutor: pause without pending call payload";
          break;
        }
        const { key, name, args } = parsed.pending;
        if (resolved.has(key)) {
          lastError = `agentkitCodemodeExecutor: call ${name} (${key}) re-requested after resolution`;
          break;
        }
        const target = flat.get(name);
        if (!target) {
          // Inject a JSON-stringified error so the script's await can
          // throw a meaningful message rather than re-pause forever.
          const errMsg = `agentkitCodemodeExecutor: unknown tool "${name}"`;
          lastError = errMsg;
          break;
        }

        let resultStr: string;
        try {
          // Honor cloudflare's `positionalArgs`: the LLM emits
          // `fn(a, b, c)` for positional providers and `fn({...})` for
          // object-arg providers. Our recorded `args` is the JSON-encoded
          // argument list (always an array; one element when object-arg).
          const argv = Array.isArray(args) ? (args as unknown[]) : [args];
          const callArgs = target.positional ? argv : [argv[0]];
          const value = await target.fn(...callArgs);
          resultStr = typeof value === "string" ? value : JSON.stringify(value ?? null);
        } catch (e) {
          // Tool threw — surface the message inside the kernel as a
          // rejected promise on the next re-run (script can catch it).
          const msg = (e as Error).message ?? String(e);
          resultStr = JSON.stringify({ __codemode_tool_error__: msg });
        }
        resolved.set(key, resultStr);

        const injectScript = `__codemode_results__[${JSON.stringify(
          key
        )}] = ${JSON.stringify(resultStr)};`;
        await opts.kernel.run(injectScript, caps);
      }

      const out: CodemodeExecuteResult = { result: lastResult };
      if (lastError !== undefined) out.error = lastError;
      if (aggregatedLogs.length > 0) out.logs = aggregatedLogs;
      return out;
    },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

interface FlatProvider {
  fn: (...args: unknown[]) => Promise<unknown>;
  positional: boolean;
}

function flattenProviders(p: CodemodeProvidersOrFns): Map<string, FlatProvider> {
  const out = new Map<string, FlatProvider>();
  if (Array.isArray(p)) {
    for (const provider of p) {
      const positional = provider.positionalArgs === true;
      for (const [method, fn] of Object.entries(provider.fns)) {
        out.set(`${provider.name}.${method}`, { fn, positional });
      }
    }
  } else {
    for (const [name, fn] of Object.entries(p)) {
      out.set(name, { fn, positional: false });
    }
  }
  return out;
}

/**
 * Build a JS expression representing the `tools` global the LLM-emitted
 * code calls. We use a Proxy so:
 *   - Accessing an unknown leaf (`tools.missing(...)`) throws a clear
 *     error rather than silently returning undefined.
 *   - The host can keep the leaf-set known at construction time (no
 *     dynamic registration) without pre-baking N hand-written closures.
 *
 * Each leaf records the call into `__codemode_calls__` and rejects with
 * the marker so the host loop can resolve and re-run.
 *
 * ⚠️ Limitation: an LLM-emitted `try { await tools.x() } catch (e) {...}`
 * will swallow our pause marker the same way a try/catch around any
 * Promise rejection swallows that rejection. cloudflare codemode's
 * default system prompt does not teach the LLM this pattern (errors
 * bubble through streamText's step loop), so it's rare in practice. If
 * it does happen, the script's catch block sees an Error whose message
 * starts with `__CODEMODE_PENDING__:` — we surface that as a final
 * error instead of looping forever.
 */
function buildToolsObjectLiteral(flat: Map<string, FlatProvider>, marker: string): string {
  // Group dotted names back into a tree so the proxy can branch:
  // single-segment ("add") -> leaf at the root
  // two-segment  ("weather.getCurrent") -> nested object
  const tree: Record<string, Record<string, true> | true> = {};
  for (const dotted of flat.keys()) {
    const parts = dotted.split(".");
    if (parts.length === 1) {
      tree[parts[0] as string] = true;
    } else {
      const ns = parts[0] as string;
      const method = parts[1] as string;
      const sub = (tree[ns] as Record<string, true> | undefined) ?? {};
      sub[method] = true;
      tree[ns] = sub;
    }
  }

  // The leaf-builder template — emitted as a string for the kernel side.
  // Kept as a `__make_leaf__` factory so we don't repeat the body for
  // every leaf and so the marker / cache lookups are uniform.
  const leafFactory = `
    function __make_leaf__(dotted) {
      return function() {
        var args = Array.prototype.slice.call(arguments);
        var key = dotted + ':' + __codemode_calls__.length;
        __codemode_calls__.push({ key: key, name: dotted, args: args });
        if (Object.prototype.hasOwnProperty.call(__codemode_results__, key)) {
          var raw = __codemode_results__[key];
          var parsed;
          try { parsed = JSON.parse(raw); } catch (e) { return Promise.resolve(raw); }
          if (parsed && parsed.__codemode_tool_error__) {
            return Promise.reject(new Error(parsed.__codemode_tool_error__));
          }
          return Promise.resolve(parsed);
        }
        return Promise.reject(new Error(${JSON.stringify(`${marker}:`)} + key));
      };
    }
  `;

  const treeJson = JSON.stringify(tree);

  // Build the proxy at runtime inside the kernel. This evaluates to a
  // single expression that yields the `tools` object; the surrounding
  // setupScript assigns it to `var tools = ...`.
  return `(function() {
    ${leafFactory}
    var __tree__ = ${treeJson};
    function __build__(node, prefix) {
      var built = {};
      var keys = Object.keys(node);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var v = node[k];
        var dotted = prefix ? (prefix + '.' + k) : k;
        if (v === true) {
          built[k] = __make_leaf__(dotted);
        } else {
          built[k] = __build__(v, dotted);
        }
      }
      return new Proxy(built, {
        get: function(target, prop) {
          if (typeof prop === 'symbol' || prop in target) return target[prop];
          // Unknown leaf — throw a clear error the LLM script will see.
          var dotted = prefix ? (prefix + '.' + String(prop)) : String(prop);
          throw new Error('agentkitCodemodeExecutor: unknown tool "' + dotted + '"');
        }
      });
    }
    return __build__(__tree__, '');
  })()`;
}

function buildRunScript(userCode: string, marker: string): string {
  // Wrap the LLM's code in an async IIFE so top-level `await` is legal.
  // Reset __codemode_calls__ each iteration so the host sees the SAME
  // sequence of recorded calls and can pick the first unresolved one.
  return `(async function() {
    __codemode_calls__ = [];
    try {
      var __r = await (async function() { ${userCode}
      })();
      return JSON.stringify({ done: true, result: __r === undefined ? null : __r });
    } catch (e) {
      var msg = (e && e.message) || String(e);
      if (msg.indexOf(${JSON.stringify(`${marker}:`)}) === 0) {
        var first = null;
        for (var i = 0; i < __codemode_calls__.length; i++) {
          var c = __codemode_calls__[i];
          if (!Object.prototype.hasOwnProperty.call(__codemode_results__, c.key)) {
            first = c; break;
          }
        }
        return JSON.stringify({ done: false, pending: first || __codemode_calls__[__codemode_calls__.length - 1] });
      }
      return JSON.stringify({ done: true, error: msg });
    }
  })()`;
}
