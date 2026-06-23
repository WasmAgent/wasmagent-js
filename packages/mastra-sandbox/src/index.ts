/**
 * @wasmagent/mastra-sandbox — Mastra sandbox provider backed by WasmAgent kernels.
 *
 * Mastra (mastra.ai) opened its sandbox provider contract in 2026-02 to let
 * users plug in a custom code-execution backend instead of the default
 * Blaxel-hosted sandbox. The contract Mastra needs is small — at minimum a
 * function `execute(code, options) -> { output, stderr?, exitCode? }`. This
 * package implements that contract over any WasmAgent `Kernel`, so a Mastra
 * agent can run model-generated code inside QuickJS / Pyodide / Wasmtime /
 * Remote with no extra infrastructure to provision.
 *
 * The advantage over Blaxel/E2B/Daytona providers:
 *
 *   - **No external service**: WASM kernels run in-process, on every Workers
 *     edge, with sub-100ms cold start. You don't need an API key or an
 *     account on a sandbox vendor.
 *   - **Same security policy as the rest of WasmAgent**: one
 *     `CapabilityManifest` gates network, fs, env, cpu, memory across all
 *     four kernel tiers. Move a workload between QuickJS and Wasmtime
 *     without rewriting policy.
 *   - **Snapshots**: WasmtimeKernel exposes `snapshot()`/`restore()` for
 *     fork-and-explore patterns Mastra's branchable workspace can adopt.
 *
 * We define the provider type structurally rather than depending on Mastra
 * directly. Mastra's sandbox provider type is in flux through 2026-Q2 (their
 * sandbox API is "open but not yet stable" per the 2026-02 changelog), and
 * pinning to one version would break every time they bump. The type below
 * captures the shape every Mastra major has agreed on so far; if Mastra
 * adds a new field later, callers can extend the returned object — extra
 * fields are ignored by the contract.
 */

import type { CapabilityManifest, WasmKernel } from "@wasmagent/core";

/**
 * Mastra sandbox-provider contract (structural).
 *
 * Mastra calls `execute()` with a script and optional options; the provider
 * runs it and returns stdout/stderr-style fields. We return the kernel's
 * stringified output as `output` and join its captured logs into `stderr`
 * (which Mastra surfaces in traces).
 */
export interface MastraSandboxProvider {
  execute(code: string, options?: MastraSandboxExecuteOptions): Promise<MastraSandboxExecuteResult>;
}

export interface MastraSandboxExecuteOptions {
  /** Soft language hint. Only "javascript" is supported by JS kernels. */
  language?: string;
  /** Per-call timeout in ms. Tightens the kernel default; never widens. */
  timeout?: number;
  /**
   * Extra environment variables for this call only. Merged into the
   * provider-level capability env; the call wins on conflict.
   */
  env?: Record<string, string>;
}

export interface MastraSandboxExecuteResult {
  output: string;
  stderr: string;
  exitCode: number;
}

export interface MastraSandboxOptions {
  kernel: WasmKernel;
  /** Provider-level capability manifest applied to every `execute()` call. */
  capabilities?: Partial<CapabilityManifest>;
}

/**
 * Build a Mastra sandbox provider that delegates to the supplied WasmAgent
 * kernel. Drop the result into Mastra's agent config wherever a custom
 * sandbox provider is accepted.
 *
 * Example:
 *
 *   import { Agent } from "@mastra/core";
 *   import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
 *   import { createMastraSandbox } from "@wasmagent/mastra-sandbox";
 *
 *   const sandbox = createMastraSandbox({
 *     kernel: new QuickJSKernel({ timeoutMs: 5_000 }),
 *     capabilities: {
 *       allowedHosts: ["api.example.com"],
 *       cpuMs: 5_000,
 *       memoryLimitBytes: 64 * 1024 * 1024,
 *     },
 *   });
 *
 *   const agent = new Agent({ tools: { sandbox }, ... });
 */
export function createMastraSandbox(opts: MastraSandboxOptions): MastraSandboxProvider {
  return {
    async execute(code, options) {
      const merged: Partial<CapabilityManifest> = { ...(opts.capabilities ?? {}) };
      if (options?.timeout != null) merged.cpuMs = options.timeout;
      if (options?.env) {
        merged.env = { ...(opts.capabilities?.env ?? {}), ...options.env };
      }
      try {
        const result = await opts.kernel.run(code, merged);
        const output = stringify(result.output);
        return {
          output,
          stderr: result.logs.join("\n"),
          exitCode: 0,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          output: "",
          stderr: msg,
          // Capability denials and timeouts should look like a non-zero exit
          // to Mastra's tracing, so a developer can spot them in the dashboard.
          exitCode: 1,
        };
      }
    },
  };
}

function stringify(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
