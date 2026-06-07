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
      // E1-edge: non-Node runtimes (Cloudflare Workers, browser) lack node:vm and
      // worker_threads. V8WasmKernel also uses node:vm and will crash at runtime.
      // Direct users to the edge-safe kernel package instead.
      if (await isEdgeRuntime()) {
        throw new Error(
          "[agentkit] Non-Node runtime detected (Cloudflare Workers / browser / Deno).\n" +
          "The default JsKernel and V8WasmKernel both require node:vm, which is unavailable.\n" +
          "Use the edge-safe QuickJS kernel instead:\n" +
          "  import { QuickJSKernel } from \"@agentkit-js/kernel-quickjs\";\n" +
          "  const kernel = new QuickJSKernel();"
        );
      }
      return new JsKernel();

    case "wasmtime": {
      // Try loading @agentkit-js/kernel-wasmtime (optional external package).
      const WASMTIME_PKG = "@agentkit-js/kernel-wasmtime";
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod = await import(WASMTIME_PKG) as { WasmtimeKernel: new (opts?: KernelOptions) => import("./types.js").WasmKernel };
        return new mod.WasmtimeKernel(opts);
      } catch (cause) {
        const err = new Error(
          "@agentkit-js/kernel-wasmtime is not installed or javy CLI is not in PATH.\n" +
          "  Install: pnpm add @agentkit-js/kernel-wasmtime\n" +
          "  javy: https://github.com/bytecodealliance/javy/releases"
        ) as Error & { code: string; cause: unknown };
        err.code = "KERNEL_NOT_INSTALLED";
        err.cause = cause;
        throw err;
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
