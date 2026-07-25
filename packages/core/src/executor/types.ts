/**
 * Result returned by any WasmKernel execution (A1).
 * Maps to smolagents' LocalPythonExecutor return contract:
 * (code) -> {output, logs, is_final_answer}
 */
export interface KernelResult {
  output: unknown;
  logs: string[];
  isFinalAnswer: boolean;
}

/**
 * Capability manifest — explicit allow-list replacing smolagents' DANGEROUS_MODULES
 * / DANGEROUS_FUNCTIONS blacklist (A2 deny-all capability model).
 *
 * The first four fields are the original A2 deny-all surface. The fields below
 * (env / resource limits) round out the "code-mode security policy face"
 * (S1/A1, 2026-06): a single object that every kernel honours uniformly, so a
 * caller can move a workload between QuickJS / Pyodide / Wasmtime / Remote
 * without rewriting policy.
 *
 * Honouring matrix (true = enforced; absent = silently ignored, which matches
 * "deny-all by default" — an absent capability is the same as a 0-length list):
 *
 *   field             JsKernel  QuickJSKernel  PyodideKernel  WasmtimeKernel  RemoteSandboxKernel
 *   allowedHosts          ✅          ✅             ✅              ✅               ✅
 *   allowedReadPaths      ✅          ✅(*)          ✅(*)           ✅(*)            ✅
 *   allowedWritePaths     ✅          ✅(*)          ✅(*)           ✅(*)            ✅
 *   extraCapabilities     ✅          ✅             ✅              ✅               ✅
 *   env                   ✅          ✅             ✅              ✅               ✅
 *   cpuMs                 ✅(timeout) ✅(deadline)   ⚠️(advisory)    ✅(per-call)     ✅(per-call)
 *   memoryLimitBytes      ✅(V8 heap) ✅             ⚠️             ⚠️(no native)    ✅(via E2B)
 *
 *   (*) FS access in WASM kernels lands on the host via an explicit __fs__
 *   bridge (see buildCapabilityGlobals); the bridge enforces allowedReadPaths
 *   / allowedWritePaths identically to JsKernel.
 *   ⚠️ Means the runtime does not expose a hard memory limit the host can apply
 *   at that call site (Pyodide and Javy/Wasmtime inherit the host process heap);
 *   the field is accepted but a runtime warning is logged so the caller is not
 *   silently misled. JsKernel is NOT in this category (issue #192): it enforces
 *   a HARD V8 heap cap at worker spawn via node:worker_threads `resourceLimits`
 *   — constructor-level only, because a live worker's heap limit cannot be
 *   resized between run() calls, so a per-call `memoryLimitBytes` smaller than
 *   the constructor cap is advisory.
 */
export interface CapabilityManifest {
  /**
   * Allowlist of hostnames the kernel may contact over the network.
   * Empty array (`[]`) = deny all network access.
   * Note: there is no `allowNetwork` boolean field — use `allowedHosts: []` to deny all.
   */
  allowedHosts: string[];
  /** Allow read access to these path prefixes. Empty = no FS reads. */
  allowedReadPaths: string[];
  /** Allow write access to these path prefixes. Empty = no FS writes. */
  allowedWritePaths: string[];
  /** Extra named capabilities (e.g. "tool:web_search"). */
  extraCapabilities: string[];
  /**
   * Environment variables to expose inside the sandbox as a `process.env`-like
   * object (`__env__` global). This is an explicit allow-list of *values*, not
   * a pass-through of the host environment — the kernel never sees `process.env`.
   *
   * Empty / absent = no env access. The injected map is read-only inside the
   * sandbox (frozen). Use sparingly: each entry crosses the trust boundary.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * Hard ceiling for a single `kernel.run()` invocation, in milliseconds.
   * Mirrors `KernelOptions.timeoutMs` but lives on the capability manifest so
   * a host can pin per-tool-call limits without owning kernel construction.
   * If both are set, the *lower* value wins (defence-in-depth).
   */
  cpuMs?: number;
  /**
   * Soft ceiling on memory usage, in bytes. Honoured by kernels that expose a
   * runtime memory limit (QuickJS, Remote). On kernels without a per-call limit
   * (Pyodide, Javy/Wasmtime) this is recorded but not enforced — see the matrix
   * above; calling code should treat enforcement as best-effort there.
   *
   * JsKernel honours this at CONSTRUCTION time (via `KernelOptions.capabilities`
   * or `KernelOptions.maxMemoryBytes`) as a hard V8 heap cap on the worker; a
   * per-call `memoryLimitBytes` passed to `run()` cannot shrink a live worker's
   * heap and is therefore advisory (issue #192).
   */
  memoryLimitBytes?: number;
}

/**
 * Unified WASM kernel abstraction (A1).
 *
 * Implementations:
 *  - JsKernel        — Node.js vm module (zero native deps, default)
 *  - WasmtimeKernel  — wasmtime Node binding (best perf, optional M1+)
 *  - VmKernel        — pure-JS fallback (serverless-safe: Workers, Lambda)
 *
 * The kernel is stateful: variables/imports persist across run() calls (cross-step state).
 * TS 5.2 explicit resource management: use `await using kernel = new JsKernel(...)`.
 */
export interface WasmKernel {
  /** Execute a code snippet; returns output, logs, and final-answer flag. */
  run(code: string, capabilities?: Partial<CapabilityManifest>): Promise<KernelResult>;
  /** Reset kernel state (clear all cross-step variables). */
  reset(): Promise<void>;
  /**
   * Snapshot linear memory + variable scope (A1 / A3).
   * Optional — only WasmtimeKernel implements this. Check `kernel.snapshot` before calling.
   */
  snapshot?(): Promise<Uint8Array>;
  /**
   * Restore from a previous snapshot. Host handles are re-established by the virtualisation layer (A3).
   * Optional — only WasmtimeKernel implements this. Check `kernel.restore` before calling.
   */
  restore?(snapshot: Uint8Array): Promise<void>;
  /** Explicit resource management — releases all host handles (A3 deterministic cleanup). */
  [Symbol.asyncDispose](): Promise<void>;
}

/** Which underlying engine to use. */
export type KernelEngine = "js" | "wasmtime" | "v8-wasm" | "quickjs" | "remote";

/**
 * Action language — which kernel backend to use for code execution.
 *
 * - "js"      — JsKernel (Node.js vm, default)
 * - "pyodide" — PyodideKernel (CPython-in-WASM via pyodide npm package)
 *
 * MicroPython has been removed: no npm package reliably exposes a Python
 * exec() API in Node.js ESM. Use "pyodide" for all Python scenarios.
 */
export type ActionLanguage = "js" | "pyodide";

export interface KernelOptions {
  engine?: KernelEngine;
  actionLanguage?: ActionLanguage;
  capabilities?: Partial<CapabilityManifest>;
  /** Max milliseconds for a single synchronous code run. Blocks infinite loops. */
  timeoutMs?: number;
  /**
   * Maximum fuel units for deterministic execution budgeting (issue #34).
   *
   * When set, the WASM binary is instrumented at load time so that every
   * instruction block deducts from an i64 fuel counter. Execution traps with
   * a `FuelExhausted` error when fuel reaches zero.
   *
   * One fuel unit roughly corresponds to one basic block of WASM instructions.
   * Typical values: 1_000_000 for lightweight scripts, 100_000_000 for heavier
   * computation.
   *
   * Currently honoured by: WasmtimeKernel (via binary instrumentation).
   * Other kernels accept the option but fall back to time-based enforcement.
   */
  fuelLimit?: number;
  /**
   * Maximum WebAssembly linear memory in bytes (issue #36).
   *
   * Enforced by rewriting the WASM memory section to include a `maximum` page
   * count (1 page = 65 536 bytes). If the guest attempts to grow memory beyond
   * this limit, `memory.grow` returns -1 (allocation failure).
   *
   * Default when omitted: no explicit cap (module-defined or engine default).
   * Currently honoured by: WasmtimeKernel (via WASM binary rewrite) and
   * JsKernel (as a hard V8 heap cap via node:worker_threads `resourceLimits`,
   * rounded up to the nearest MiB — issue #192).
   */
  maxMemoryBytes?: number;
  /**
   * Epoch tick interval in milliseconds for cooperative interruption (issue #35).
   *
   * Controls how frequently the host checks whether the execution deadline has
   * been exceeded. A smaller value gives tighter deadline enforcement at the
   * cost of slightly higher timer overhead.
   *
   * Default: 10ms. Range: 1-1000ms.
   * Currently honoured by: WasmtimeKernel.
   */
  epochTickMs?: number;
}
