/**
 * Dual-engine kernel factory (A1 dual-engine fallback).
 *
 * Tries to load the wasmtime Node binding first (best perf + real WASM sandbox).
 * Falls back to V8WasmKernel (pure-JS, serverless-safe) if the native addon
 * is unavailable (Lambda, Alpine, Cloudflare Workers).
 * JsKernel is the default engine for local development.
 *
 * Edge runtime detection: if worker_threads is unavailable (Cloudflare Workers,
 * browser), JsKernel auto-falls back to V8WasmKernel (E1-edge).
 */
import type { KernelOptions, WasmKernel } from "./types.js";
import { JsKernel } from "./JsKernel.js";

/** True when the current runtime does not support Node's worker_threads module. */
async function isEdgeRuntime(): Promise<boolean> {
  // Non-Node runtimes (Cloudflare Workers, browser, Deno) don't expose process.release.
  if (typeof process === "undefined" || process.release?.name !== "node") {
    return true;
  }
  // On real Node, confirm worker_threads is usable (guards against stripped builds).
  try {
    await import("node:worker_threads");
    return false;
  } catch {
    return true;
  }
}

export async function createKernel(
  opts: KernelOptions = {}
): Promise<WasmKernel> {
  const { engine = "js", actionLanguage } = opts;

  switch (engine) {
    case "js":
      if (actionLanguage === "pyodide") {
        // PyodideKernel lives in @agentkit-js/kernel-pyodide to keep core lean.
        // Import it directly from that package instead of using createKernel:
        //   import { PyodideKernel } from "@agentkit-js/kernel-pyodide";
        //   const kernel = new PyodideKernel();
        throw new Error(
          'actionLanguage "pyodide" is not routed through createKernel.\n' +
          'Import PyodideKernel directly:\n' +
          '  import { PyodideKernel } from "@agentkit-js/kernel-pyodide";\n' +
          '  const kernel = new PyodideKernel();'
        );
      }
      // E1-edge: fall back to V8WasmKernel when worker_threads is not available
      // (Cloudflare Workers, browser, Deno without --unstable-node-globals).
      if (await isEdgeRuntime()) {
        console.warn(
          "[agentkit] worker_threads unavailable — falling back to V8WasmKernel for edge runtime"
        );
        const { V8WasmKernel } = await import("./V8WasmKernel.js");
        return new V8WasmKernel(opts);
      }
      return new JsKernel();

    case "wasmtime": {
      // Try loading @agentkit-js/kernel-wasmtime (optional external package).
      // We use a runtime-computed specifier so TypeScript does not attempt to
      // resolve the module at type-check time (the package is an optional peer
      // and is not in core's dependency graph — importing it statically would
      // create a circular dependency: kernel-wasmtime → core → kernel-wasmtime).
      const WASMTIME_PKG = "@agentkit-js/kernel-wasmtime";
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod = await import(WASMTIME_PKG) as { WasmtimeKernel: new (opts?: KernelOptions) => import("./types.js").WasmKernel };
        return new mod.WasmtimeKernel(opts);
      } catch {
        console.warn(
          "[agentkit] @agentkit-js/kernel-wasmtime unavailable (or javy CLI not in PATH) — " +
            "falling back to V8 WebAssembly path.\n" +
            "  Install: pnpm add @agentkit-js/kernel-wasmtime && " +
            "https://github.com/bytecodealliance/javy/releases"
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
