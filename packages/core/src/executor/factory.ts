/**
 * Multi-engine kernel factory.
 *
 * Supported engines:
 *   "js"       — JsKernel (Node.js vm module, default)
 *   "v8-wasm"  — VmKernel (pure-JS, serverless-safe)
 *   "quickjs"  — QuickJSKernel from @wasmagent/kernel-quickjs (edge-safe, WASM)
 *   "wasmtime" — WasmtimeKernel from @wasmagent/kernel-wasmtime (true WASM + WASI)
 *   "remote"   — RemoteSandboxKernel from @wasmagent/kernel-remote (microVM via E2B)
 *
 * actionLanguage="pyodide" routes to @wasmagent/kernel-pyodide (Python-in-WASM).
 *
 * Edge runtime detection: if worker_threads is unavailable (Cloudflare Workers,
 * browser), "js" throws with guidance to use "quickjs".
 */

import { JsKernel } from "./JsKernel.js";
import type { KernelOptions, WasmKernel } from "./types.js";

/** True when the current runtime does not support Node's worker_threads module. */
async function isEdgeRuntime(): Promise<boolean> {
  if (typeof process === "undefined" || process.release?.name !== "node") {
    return true;
  }
  try {
    await import("node:worker_threads");
    return false;
  } catch {
    return true;
  }
}

function kernelNotInstalled(pkg: string, extra?: string): Error {
  const err = new Error(
    `${pkg} is not installed.\n  Install: pnpm add ${pkg}\n${extra ? `  ${extra}\n` : ""}`
  ) as Error & { code: string };
  err.code = "KERNEL_NOT_INSTALLED";
  return err;
}

export async function createKernel(opts: KernelOptions = {}): Promise<WasmKernel> {
  const { engine = "js", actionLanguage } = opts;

  // actionLanguage="pyodide" always routes to kernel-pyodide regardless of engine.
  if (actionLanguage === "pyodide") {
    const PYODIDE_PKG = "@wasmagent/kernel-pyodide";
    try {
      const mod = (await import(PYODIDE_PKG)) as {
        PyodideKernel: new (opts?: KernelOptions) => WasmKernel;
      };
      return new mod.PyodideKernel(opts);
    } catch (cause) {
      const err = kernelNotInstalled(PYODIDE_PKG, "Docs: https://pyodide.org") as Error & {
        cause: unknown;
      };
      err.cause = cause;
      throw err;
    }
  }

  switch (engine) {
    case "js":
      if (await isEdgeRuntime()) {
        throw new Error(
          "[wasmagent] Non-Node runtime detected (Cloudflare Workers / browser / Deno).\n" +
            "The default JsKernel and VmKernel both require node:vm, which is unavailable.\n" +
            "Use the edge-safe QuickJS kernel instead:\n" +
            '  import { QuickJSKernel } from "@wasmagent/kernel-quickjs";\n' +
            "  const kernel = new QuickJSKernel();"
        );
      }
      return new JsKernel();

    case "quickjs": {
      const QUICKJS_PKG = "@wasmagent/kernel-quickjs";
      try {
        const mod = (await import(QUICKJS_PKG)) as {
          QuickJSKernel: new (opts?: KernelOptions) => WasmKernel;
        };
        return new mod.QuickJSKernel(opts);
      } catch (cause) {
        const err = kernelNotInstalled(QUICKJS_PKG) as Error & { cause: unknown };
        err.cause = cause;
        throw err;
      }
    }

    case "wasmtime": {
      const WASMTIME_PKG = "@wasmagent/kernel-wasmtime";
      try {
        const mod = (await import(WASMTIME_PKG)) as {
          WasmtimeKernel: new (opts?: KernelOptions) => WasmKernel;
        };
        return new mod.WasmtimeKernel(opts);
      } catch (cause) {
        const err = kernelNotInstalled(
          WASMTIME_PKG,
          "javy: https://github.com/bytecodealliance/javy/releases"
        ) as Error & { cause: unknown };
        err.cause = cause;
        throw err;
      }
    }

    case "v8-wasm": {
      const { VmKernel } = await import("./VmKernel.js");
      return new VmKernel(opts);
    }

    case "remote": {
      const REMOTE_PKG = "@wasmagent/kernel-remote";
      try {
        const mod = (await import(REMOTE_PKG)) as {
          RemoteSandboxKernel: new (opts?: KernelOptions) => WasmKernel;
        };
        return new mod.RemoteSandboxKernel(opts);
      } catch (cause) {
        const err = kernelNotInstalled(
          REMOTE_PKG,
          "Also requires the 'e2b' peer dependency: pnpm add e2b"
        ) as Error & { cause: unknown };
        err.cause = cause;
        throw err;
      }
    }

    default:
      throw new Error(`Unknown kernel engine: ${String(engine)}`);
  }
}
