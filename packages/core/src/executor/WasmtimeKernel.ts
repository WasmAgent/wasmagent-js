import type { CapabilityManifest, KernelOptions, KernelResult, WasmKernel } from "./types.js";

/**
 * WasmtimeKernel — placeholder that throws on construction.
 *
 * The real implementation lives in @wasmagent/kernel-wasmtime (optional).
 * factory.ts attempts to import that package dynamically when engine:"wasmtime"
 * is selected; if it is not installed this class is never instantiated.
 */
export class WasmtimeKernel implements WasmKernel {
  constructor(_opts?: KernelOptions) {
    throw new Error(
      "WasmtimeKernel: install @wasmagent/kernel-wasmtime and ensure `javy` CLI is in PATH.\n" +
        "  pnpm add @wasmagent/kernel-wasmtime\n" +
        "  https://github.com/bytecodealliance/javy/releases"
    );
  }

  run(_code: string, _capabilities?: Partial<CapabilityManifest>): Promise<KernelResult> {
    return Promise.reject(new Error("WasmtimeKernel not available"));
  }

  reset(): Promise<void> {
    return Promise.reject(new Error("WasmtimeKernel not available"));
  }

  [Symbol.asyncDispose](): Promise<void> {
    return Promise.resolve();
  }
}
