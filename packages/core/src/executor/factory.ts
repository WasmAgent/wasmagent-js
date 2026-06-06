/**
 * Dual-engine kernel factory (A1 dual-engine fallback).
 *
 * Tries to load the wasmtime Node binding first (best perf + real WASM sandbox).
 * Falls back to V8WasmKernel (pure-JS, serverless-safe) if the native addon
 * is unavailable (Lambda, Alpine, Cloudflare Workers).
 * JsKernel is the default engine for local development.
 */
import type { KernelOptions, WasmKernel } from "./types.js";
import { JsKernel } from "./JsKernel.js";

export async function createKernel(
  opts: KernelOptions = {}
): Promise<WasmKernel> {
  const { engine = "js", actionLanguage } = opts;

  switch (engine) {
    case "js":
      if (actionLanguage === "pyodide") {
        // PyodideKernel is now in the separate @agentkit-js/kernel-pyodide package.
        // Attempt a dynamic import so users who have it installed get it automatically;
        // give a clear, actionable error if they don't.
        try {
          // @ts-expect-error — @agentkit-js/kernel-pyodide is an optional peer package
          const { PyodideKernel } = await import("@agentkit-js/kernel-pyodide");
          return new (PyodideKernel as new (opts: KernelOptions) => WasmKernel)(opts);
        } catch {
          throw new Error(
            'actionLanguage "pyodide" requires the @agentkit-js/kernel-pyodide package.\n' +
            'Install it with: pnpm add @agentkit-js/kernel-pyodide pyodide'
          );
        }
      }
      return new JsKernel();

    case "wasmtime": {
      // Attempt to load the native wasmtime binding (M1+).
      // If unavailable, log a warning and fall through to V8 fallback (A1 dual-engine).
      try {
        const { WasmtimeKernel } = await import("./WasmtimeKernel.js");
        return new WasmtimeKernel(opts);
      } catch {
        console.warn(
          "[agentkit] wasmtime native addon unavailable — falling back to V8 WebAssembly path"
        );
        const { V8WasmKernel } = await import("./V8WasmKernel.js");
        return new V8WasmKernel(opts);
      }
    }

    case "v8-wasm": {
      const { V8WasmKernel } = await import("./V8WasmKernel.js");
      return new V8WasmKernel(opts);
    }

    default:
      throw new Error(`Unknown kernel engine: ${String(engine)}`);
  }
}
