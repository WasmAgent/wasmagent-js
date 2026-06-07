import type { CapabilityManifest, KernelOptions, KernelResult, WasmKernel } from "./types.js";

/**
 * WasmtimeKernel — native wasmtime Node binding (M1+).
 *
 * Not yet implemented. The factory falls back to V8WasmKernel when this
 * module is unavailable (A1 dual-engine fallback).
 */
export class WasmtimeKernel implements WasmKernel {
  constructor(_opts?: KernelOptions) {
    throw new Error(
      "WasmtimeKernel: native wasmtime binding not installed. " +
        "Install the optional @agentkit-js/wasmtime peer dependency (M1)."
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
