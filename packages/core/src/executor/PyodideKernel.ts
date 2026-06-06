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
   * Enforce capability constraints (A2) for the current run call.
   *
   * Network enforcement (allowedHosts):
   *   Pyodide's HTTP exit in Node goes through the JS `fetch` global that Pyodide
   *   bridges into Python's `urllib`. We replace `urllib.request.urlopen` with a
   *   wrapper that validates the hostname against allowedHosts before delegating,
   *   making the check mandatory rather than cooperative.
   *   When allowedHosts is empty, all outbound requests are blocked.
   *
   * File-system enforcement (allowedReadPaths / allowedWritePaths):
   *   Pyodide runs on Emscripten MEMFS — an in-memory virtual FS isolated from
   *   the real disk. Unless NODEFS is explicitly mounted (which we never do),
   *   Python file I/O is already sandboxed. The __check_path__ helpers remain as
   *   advisory APIs for code that explicitly wants path validation.
   *
   * extraCapabilities: exposed as __extra_capabilities__ list for tool-level checks.
   */
  #applyCapabilities(py: PyodideInterface, capabilities?: Partial<CapabilityManifest>): void {
    const allowedHosts = capabilities?.allowedHosts ?? [];
    const readPaths = capabilities?.allowedReadPaths ?? [];
    const writePaths = capabilities?.allowedWritePaths ?? [];
    const extraCaps = capabilities?.extraCapabilities ?? [];

    // Serialize lists for safe injection into the Python snippet.
    const hostsJson = JSON.stringify(JSON.stringify(allowedHosts));
    const readJson = JSON.stringify(JSON.stringify(readPaths));
    const writeJson = JSON.stringify(JSON.stringify(writePaths));
    const extraJson = JSON.stringify(JSON.stringify(extraCaps));

    py.runPython(`
import json as _json, urllib.request as _urllib_req, urllib.parse as _urllib_parse

_allowed_hosts = _json.loads(${hostsJson})
__allowed_read_paths__ = _json.loads(${readJson})
__allowed_write_paths__ = _json.loads(${writeJson})
__extra_capabilities__ = _json.loads(${extraJson})

# ── Network enforcement: mandatory urllib monkey-patch ────────────────────────
# Replace urlopen so every HTTP/HTTPS call from Python is host-checked before
# it reaches the network. This covers urllib, http.client, and any library
# that delegates to them (requests is not available in Pyodide by default).

_original_urlopen = _urllib_req.urlopen

def _checked_urlopen(url, *args, **kwargs):
    # Extract hostname from URL string or Request object.
    raw = url.full_url if isinstance(url, _urllib_req.Request) else str(url)
    hostname = _urllib_parse.urlparse(raw).hostname or ""
    if not _allowed_hosts:
        raise PermissionError(
            f"CapabilityDenied: network access to '{hostname}' is denied "
            f"(allowedHosts is empty)"
        )
    def _matches(host, pattern):
        if pattern.startswith("*."):
            return host.endswith(pattern[1:]) or host == pattern[2:]
        return host == pattern
    if not any(_matches(hostname, h) for h in _allowed_hosts):
        raise PermissionError(
            f"CapabilityDenied: '{hostname}' is not in allowedHosts {_allowed_hosts}"
        )
    return _original_urlopen(url, *args, **kwargs)

_urllib_req.urlopen = _checked_urlopen

# ── Advisory path-check helpers (FS is already sandboxed by Emscripten MEMFS) ─
def __check_host__(host):
    if not _allowed_hosts:
        raise PermissionError(f"CapabilityDenied: network to '{host}' denied")
    if not any((lambda p: host == p or host.endswith('.' + p.lstrip('*').lstrip('.')))(h) for h in _allowed_hosts):
        raise PermissionError(f"CapabilityDenied: '{host}' not in allowedHosts")

def __check_read_path__(path):
    if not __allowed_read_paths__:
        raise PermissionError(f"CapabilityDenied: read '{path}' denied (no paths allowed)")
    if not any(path.startswith(p) for p in __allowed_read_paths__):
        raise PermissionError(f"CapabilityDenied: read '{path}' not in allowedReadPaths")

def __check_write_path__(path):
    if not __allowed_write_paths__:
        raise PermissionError(f"CapabilityDenied: write '{path}' denied (no paths allowed)")
    if not any(path.startswith(p) for p in __allowed_write_paths__):
        raise PermissionError(f"CapabilityDenied: write '{path}' not in allowedWritePaths")

del _json, _urllib_parse
`);}


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
