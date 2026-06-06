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
 */
export interface CapabilityManifest {
  /** Allow outbound HTTP to these domains (glob patterns). Empty = no network. */
  allowedHosts: string[];
  /** Allow read access to these path prefixes. Empty = no FS reads. */
  allowedReadPaths: string[];
  /** Allow write access to these path prefixes. Empty = no FS writes. */
  allowedWritePaths: string[];
  /** Extra named capabilities (e.g. "tool:web_search"). */
  extraCapabilities: string[];
}

/**
 * Unified WASM kernel abstraction (A1).
 *
 * Implementations:
 *  - JsKernel        — Node.js vm module (zero native deps, default)
 *  - WasmtimeKernel  — wasmtime Node binding (best perf, optional M1+)
 *  - V8WasmKernel    — pure-JS fallback (serverless-safe: Workers, Lambda)
 *
 * The kernel is stateful: variables/imports persist across run() calls (cross-step state).
 * TS 5.2 explicit resource management: use `await using kernel = new JsKernel(...)`.
 */
export interface WasmKernel {
  /** Execute a code snippet; returns output, logs, and final-answer flag. */
  run(code: string, capabilities?: Partial<CapabilityManifest>): Promise<KernelResult>;
  /** Reset kernel state (clear all cross-step variables). */
  reset(): Promise<void>;
  /** Snapshot linear memory + variable scope (A1 / A3). */
  snapshot(): Promise<Uint8Array>;
  /** Restore from a previous snapshot. Host handles are re-established by the virtualisation layer (A3). */
  restore(snapshot: Uint8Array): Promise<void>;
  /** Explicit resource management — releases all host handles (A3 deterministic cleanup). */
  [Symbol.asyncDispose](): Promise<void>;
}

/** Which underlying engine to use. */
export type KernelEngine = "js" | "wasmtime" | "v8-wasm";

/** Action language (D1 three-way spike decision). */
export type ActionLanguage = "js" | "micropython" | "pyodide";

export interface KernelOptions {
  engine?: KernelEngine;
  actionLanguage?: ActionLanguage;
  capabilities?: Partial<CapabilityManifest>;
}
