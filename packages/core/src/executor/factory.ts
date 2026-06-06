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

  // Warn when MicroPython is requested — not yet implemented, falls back to js.
  if (actionLanguage === "micropython") {
    console.warn(
      `[agentkit] actionLanguage "micropython" is not yet implemented — falling back to "js". ` +
        `MicroPython backend is planned for a future release.`
    );
  }

  switch (engine) {
    case "js":
      // When actionLanguage is 'pyodide', use PyodideKernel regardless of engine.
      if (actionLanguage === "pyodide") {
        const { PyodideKernel } = await import("./PyodideKernel.js");
        return new PyodideKernel(opts);
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
