import type { CapabilityManifest, KernelOptions, KernelResult, WasmKernel } from "./types.js";

interface PyodideInterface {
  runPython(code: string): unknown;
  globals: { get(name: string): unknown; set(name: string, value: unknown): void };
  setStdout(opts: { batched: (s: string) => void }): void;
  setStderr(opts: { batched: (s: string) => void }): void;
  toPy(obj: unknown): unknown;
  toJs(obj: unknown): unknown;
}

/**
 * PyodideKernel — runs Python code in a Pyodide (CPython-in-WASM) sandbox (A4).
 *
 * Uses the `pyodide` npm package (pure JS/WASM, no native binaries required).
 * A4 target from the spec: full CPython semantics, numpy/scipy/pandas available
 * via pyodide.loadPackage().
 *
 * State model mirrors JsKernel:
 *  - Python globals persist across run() calls (stateful kernel).
 *  - __final_answer__ sentinel signals the agent's final answer.
 *  - reset() clears all Python globals and re-initialises the namespace.
 *  - snapshot()/restore() serialise via JSON (functions not preserved).
 *
 * Pyodide is loaded lazily on the first run() call (~500ms first-use overhead).
 */
export class PyodideKernel implements WasmKernel {
  #py: PyodideInterface | null = null;
  #logs: string[] = [];
  #initPromise: Promise<PyodideInterface> | null = null;

  constructor(_opts?: KernelOptions) {}

  async #ensurePyodide(): Promise<PyodideInterface> {
    if (this.#py) return this.#py;
    if (this.#initPromise) return this.#initPromise;

    this.#initPromise = (async () => {
      const { loadPyodide } = await import("pyodide");
      // Resolve the pyodide package directory so its WASM assets can be found
      // regardless of the module resolution root (monorepo, pnpm hoisting, etc.).
      // Use a plain POSIX path (no file:// prefix) — Pyodide handles both forms
      // but the file:// form breaks under vitest's module resolver.
      const { createRequire } = await import("node:module");
      const { dirname } = await import("node:path");
      const pkgRequire = createRequire(import.meta.url);
      const pkgJsonPath = pkgRequire.resolve("pyodide/package.json");
      const indexURL = dirname(pkgJsonPath) + "/";

      const py = await loadPyodide({ indexURL }) as unknown as PyodideInterface;
      // Initialise the __final_answer__ sentinel.
      py.runPython("__final_answer__ = None");
      this.#py = py;
      return py;
    })();
    return this.#initPromise;
  }

  #attachCapture(py: PyodideInterface): void {
    py.setStdout({ batched: (s: string) => { this.#logs.push(s); } });
    py.setStderr({ batched: (s: string) => { this.#logs.push(`[stderr] ${s}`); } });
  }

  async run(
    code: string,
    capabilities?: Partial<CapabilityManifest>
  ): Promise<KernelResult> {
    const py = await this.#ensurePyodide();
    this.#logs = [];
    this.#attachCapture(py);

    // Reset the sentinel before each run.
    py.globals.set("__final_answer__", null);

    // A2: inject/revoke capability globals per call.
    this.#applyCapabilities(py, capabilities);

    let output: unknown;
    try {
      output = py.runPython(code);
    } catch (err) {
      throw new Error(
        `PyodideKernelError: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const finalAnswer = py.globals.get("__final_answer__");
    const isFinalAnswer = finalAnswer !== null && finalAnswer !== undefined;

    return {
      output: isFinalAnswer ? finalAnswer : output,
      logs: [...this.#logs],
      isFinalAnswer,
    };
  }

  /**
   * Inject Python-side capability globals based on the manifest (A2).
   *
   * - allowedHosts  → `__allowed_hosts__` list; Python code can use `urllib.request`
   *   after checking `if host in __allowed_hosts__`. A deny helper `__check_host__`
   *   is also injected so Python code can call it before making requests.
   * - allowedReadPaths / allowedWritePaths → `__allowed_read_paths__` /
   *   `__allowed_write_paths__` lists; a `__check_path__` helper validates access.
   * - No capabilities → lists are empty; helper raises CapabilityDenied for any call.
   */
  #applyCapabilities(py: PyodideInterface, capabilities?: Partial<CapabilityManifest>): void {
    const hosts = JSON.stringify(capabilities?.allowedHosts ?? []);
    const readPaths = JSON.stringify(capabilities?.allowedReadPaths ?? []);
    const writePaths = JSON.stringify(capabilities?.allowedWritePaths ?? []);
    const extraCaps = JSON.stringify(capabilities?.extraCapabilities ?? []);

    py.runPython(`
import json as _json

__allowed_hosts__ = _json.loads(${JSON.stringify(hosts)})
__allowed_read_paths__ = _json.loads(${JSON.stringify(readPaths)})
__allowed_write_paths__ = _json.loads(${JSON.stringify(writePaths)})
__extra_capabilities__ = _json.loads(${JSON.stringify(extraCaps)})

def __check_host__(host):
    if not __allowed_hosts__:
        raise PermissionError(f"CapabilityDenied: network access to '{host}' is denied (no hosts allowed)")
    if not any(host == h or host.endswith('.' + h.lstrip('*').lstrip('.')) for h in __allowed_hosts__):
        raise PermissionError(f"CapabilityDenied: '{host}' is not in __allowed_hosts__ {__allowed_hosts__}")

def __check_read_path__(path):
    if not __allowed_read_paths__:
        raise PermissionError(f"CapabilityDenied: read access to '{path}' is denied (no paths allowed)")
    if not any(path.startswith(p) for p in __allowed_read_paths__):
        raise PermissionError(f"CapabilityDenied: read '{path}' not in __allowed_read_paths__ {__allowed_read_paths__}")

def __check_write_path__(path):
    if not __allowed_write_paths__:
        raise PermissionError(f"CapabilityDenied: write access to '{path}' is denied (no paths allowed)")
    if not any(path.startswith(p) for p in __allowed_write_paths__):
        raise PermissionError(f"CapabilityDenied: write '{path}' not in __allowed_write_paths__ {__allowed_write_paths__}")

del _json
`);
  }

  async reset(): Promise<void> {
    if (!this.#py) return;
    // Clear all user-defined globals and re-seed the sentinel.
    this.#py.runPython(`
import sys
# Remove all user-defined names, keep builtins.
for _k in list(globals().keys()):
    if not _k.startswith('__'):
        del globals()[_k]
__final_answer__ = None
`);
    this.#logs = [];
  }

  async snapshot(): Promise<Uint8Array> {
    const py = await this.#ensurePyodide();
    // Serialise all serialisable globals to JSON.
    // Non-serialisable values (functions, modules) are skipped.
    const state = py.runPython(`
import json
_snap = {}
for _k, _v in list(globals().items()):
    if _k.startswith('_') and _k != '__final_answer__':
        continue
    try:
        json.dumps(_v)
        _snap[_k] = _v
    except Exception:
        pass
json.dumps(_snap)
`) as string;
    return new TextEncoder().encode(state);
  }

  async restore(snapshot: Uint8Array): Promise<void> {
    const py = await this.#ensurePyodide();
    const jsonStr = new TextDecoder().decode(snapshot);
    py.runPython(`
import json as _json
_snap = _json.loads(${JSON.stringify(jsonStr)})
globals().update(_snap)
del _snap, _json
`);
    this.#logs = [];
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.reset();
    this.#py = null;
    this.#initPromise = null;
  }
}
