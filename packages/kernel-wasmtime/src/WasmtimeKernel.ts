import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WASI } from "node:wasi";
import type {
  CapabilityManifest,
  KernelOptions,
  KernelResult,
  WasmKernel,
} from "@wasmagent/core/executor";

const execFileAsync = promisify(execFile);

export interface WasmtimeKernelOptions extends KernelOptions {
  /**
   * Absolute path to the `javy` CLI binary. Defaults to `javy` (resolved via PATH).
   * Install: https://github.com/bytecodealliance/javy/releases
   */
  javyPath?: string;
}

/**
 * WasmtimeKernel — true WASM sandbox via Javy (QuickJS compiled to WASM + WASI).
 *
 * Each run() call:
 *   1. Writes the agent code + harness to a temp .js file.
 *   2. Invokes `javy compile` to produce a self-contained .wasm (QuickJS + user code).
 *   3. Runs the .wasm using Node's native WebAssembly + node:wasi — no wasmtime CLI needed.
 *   4. Captures stdout as JSON result; stderr as log lines.
 *
 * Security properties:
 *   - True WASM memory isolation: the QuickJS interpreter and user JS run inside a
 *     WebAssembly linear memory sandbox. Host memory is not accessible from user code.
 *   - WASI syscall gating: node:wasi only grants the syscalls we explicitly allow.
 *     By default we grant nothing beyond stdout/stderr; fetch/fs gates are enforced
 *     at the JS harness layer before any syscall is reached.
 *   - No persistent VM context: every run() gets a fresh QuickJS instance, so there
 *     is no cross-run state leakage (unlike QuickJSKernel which reuses a context).
 *
 * Cross-run state:
 *   Because each run() creates a new WASM instance, JS variables do not persist
 *   between calls. State is emulated via the #stateJson bag: the harness injects
 *   a serialised snapshot of prior variables at the top of every execution, and
 *   the harness footer captures updated values back into the bag after the run.
 *
 * Snapshot/restore:
 *   WasmtimeKernel implements the optional snapshot()/restore() interface. A snapshot
 *   is a serialised JSON string of the current #stateJson bag. This lets the caller
 *   fork execution, try an alternate path, and roll back to the checkpoint.
 *
 * Prerequisites:
 *   `javy` CLI must be installed and available in PATH (or passed via `javyPath`).
 *   Install: https://github.com/bytecodealliance/javy/releases
 *
 * @example
 * ```ts
 * import { WasmtimeKernel } from "@wasmagent/kernel-wasmtime";
 * await using kernel = new WasmtimeKernel();
 * const result = await kernel.run("1 + 2");
 * console.log(result.output); // 3
 * ```
 */
export class WasmtimeKernel implements WasmKernel {
  readonly #javyPath: string;
  readonly #timeoutMs: number;

  // Emulated cross-run state bag: maps variable name → JSON-serialised value.
  #stateJson: Record<string, string> = {};

  constructor(opts?: WasmtimeKernelOptions) {
    this.#javyPath = opts?.javyPath ?? "javy";
    this.#timeoutMs = opts?.timeoutMs ?? 10_000;
  }

  async run(code: string, capabilities?: Partial<CapabilityManifest>): Promise<KernelResult> {
    const allowedHosts = capabilities?.allowedHosts ?? [];
    const env = capabilities?.env ?? {};
    // Per-call cpuMs (capability) takes precedence over the constructor
    // default (opts.timeoutMs). This matches the "capability honouring
    // matrix" in @wasmagent/core/executor/types: cpuMs is per-call.
    const effectiveTimeoutMs = capabilities?.cpuMs ?? this.#timeoutMs;
    const src = buildJavySource(code, allowedHosts, this.#stateJson, env);

    let tmpDir: string | undefined;
    try {
      tmpDir = await mkdtemp(join(tmpdir(), "agentkit-wasmtime-"));
      const jsPath = join(tmpDir, "agent.js");
      const wasmPath = join(tmpDir, "agent.wasm");

      await writeFile(jsPath, src, "utf8");

      // Step 1: compile JS → self-contained WASM via javy.
      // javy embeds QuickJS + the user JS into a single WASM binary that speaks WASI.
      try {
        await execFileAsync(this.#javyPath, ["compile", jsPath, "-o", wasmPath], {
          timeout: effectiveTimeoutMs,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT") || msg.includes("not found") || msg.includes("No such file")) {
          throw new Error(
            "WasmtimeKernel: `javy` CLI not found. " +
              `Install from https://github.com/bytecodealliance/javy/releases (javyPath="${this.#javyPath}")`
          );
        }
        throw new Error(`WasmtimeKernel: javy compile failed — ${msg}`);
      }

      // Step 2: run the compiled WASM using Node's native WebAssembly + node:wasi.
      // We pass the state bag via stdin; stdout carries the JSON result envelope.
      const stdinData = JSON.stringify(this.#stateJson);
      const { stdout, stderr, newState } = await runWasm(wasmPath, stdinData);

      // Persist updated state bag for subsequent run() calls.
      this.#stateJson = newState;

      const logs = stderr
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      let envelope: { output: unknown; isFinalAnswer: boolean; finalAnswer?: unknown };
      try {
        envelope = JSON.parse(stdout.trim()) as typeof envelope;
      } catch {
        throw new Error(
          `WasmtimeKernel: harness output is not valid JSON — ${stdout.slice(0, 200)}`
        );
      }

      const output = envelope.isFinalAnswer ? envelope.finalAnswer : envelope.output;
      return { output, logs, isFinalAnswer: envelope.isFinalAnswer };
    } finally {
      if (tmpDir) {
        await rm(tmpDir, { recursive: true, force: true });
      }
    }
  }

  async reset(): Promise<void> {
    this.#stateJson = {};
  }

  async snapshot(): Promise<Uint8Array> {
    return new TextEncoder().encode(JSON.stringify(this.#stateJson));
  }

  async restore(snapshot: Uint8Array): Promise<void> {
    const bag = JSON.parse(new TextDecoder().decode(snapshot)) as Record<string, string>;
    this.#stateJson = bag;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#stateJson = {};
  }
}

// ─── Module-level helpers (exported for testability) ─────────────────────────

/**
 * Build the full JS source that Javy will compile.
 *
 * Architecture: The harness wraps user code so that:
 *   1. The prior state bag (injected via stdin) is restored as global vars.
 *   2. User code runs inside a try/catch.
 *   3. __finalAnswer__ / __final_answer__ are detected.
 *   4. A result envelope is written to stdout as a single JSON line.
 *   5. The updated state bag is serialised and appended on a second line.
 *
 * fetch() is provided as a capability-gated shim if allowedHosts is non-empty;
 * otherwise fetch is explicitly set to undefined (deny-all baseline).
 *
 * Note: Javy's QuickJS does not expose Node APIs — only standard JS + WASI stdio.
 * The harness uses Javy.IO if available for stdin/stdout, falling back to a
 * fallback shim suitable for testing outside a real WASM context.
 */
export function buildJavySource(
  code: string,
  allowedHosts: string[],
  stateJson: Record<string, string>,
  env: Record<string, string> = {}
): string {
  const stateJsonLiteral = JSON.stringify(JSON.stringify(stateJson));
  const hostsJsonLiteral = JSON.stringify(allowedHosts);
  const envJsonLiteral = JSON.stringify(env);

  return `// ── Javy harness for WasmtimeKernel ──────────────────────────────────────────
(function() {
  "use strict";

  // ── Stdin/stdout helpers (Javy WASI I/O) ───────────────────────────────────
  function readStdin() {
    try {
      var buf = Javy.IO.readSync(0);
      return new TextDecoder().decode(buf);
    } catch (_) { return ${stateJsonLiteral}; }
  }

  function writeStdout(s) {
    try {
      Javy.IO.writeSync(1, new TextEncoder().encode(s));
    } catch (_) {
      if (typeof process !== "undefined" && process.stdout) {
        process.stdout.write(s);
      }
    }
  }

  function writeStderr(s) {
    try {
      Javy.IO.writeSync(2, new TextEncoder().encode(s));
    } catch (_) {
      if (typeof process !== "undefined" && process.stderr) {
        process.stderr.write(s);
      }
    }
  }

  // ── Restore prior state bag ────────────────────────────────────────────────
  var __state__ = {};
  try {
    __state__ = JSON.parse(readStdin()) || {};
  } catch (_) {}

  for (var __k__ in __state__) {
    if (Object.prototype.hasOwnProperty.call(__state__, __k__)) {
      try { globalThis[__k__] = JSON.parse(__state__[__k__]); } catch (_) {}
    }
  }

  // ── Console capture ────────────────────────────────────────────────────────
  var __logs__ = [];
  globalThis.console = {
    log: function() { __logs__.push(Array.prototype.slice.call(arguments).join(" ")); },
    warn: function() { __logs__.push(Array.prototype.slice.call(arguments).join(" ")); },
    error: function() { __logs__.push(Array.prototype.slice.call(arguments).join(" ")); },
  };

  // ── Capability gate: fetch ─────────────────────────────────────────────────
  var __allowed_hosts__ = ${hostsJsonLiteral};
  if (__allowed_hosts__.length === 0) {
    globalThis.fetch = undefined;
  } else {
    globalThis.fetch = function(url) {
      var hostname = (new URL(url)).hostname;
      var ok = __allowed_hosts__.some(function(h) {
        if (h.indexOf("*") === -1) return h === hostname;
        var pat = new RegExp("^" + h.replace(/\\./g, "\\\\.").replace(/\\*/g, "[^.]*") + "$");
        return pat.test(hostname);
      });
      if (!ok) throw new Error("CapabilityDenied: fetch to \\"" + hostname + "\\" not in allowedHosts");
      throw new Error("WasmtimeKernel: async fetch is not supported inside WASM. Use a tool instead.");
    };
  }

  // ── Sentinel variables ─────────────────────────────────────────────────────
  globalThis.__finalAnswer__ = undefined;
  globalThis.__final_answer__ = undefined;

  // ── Capability env (frozen, per-call view) ─────────────────────────────────
  // Mirrors JsKernel/QuickJSKernel/PyodideKernel: env is the only way for
  // user code to reach API keys etc. — there's no host process.env leak.
  globalThis.__env__ = Object.freeze(${envJsonLiteral});

  // ── Execute user code ──────────────────────────────────────────────────────
  var __output__ = undefined;
  var __error__ = null;
  try {
    // Use indirect eval so the last-expression value is captured, matching
    // the vm.Script.runInContext() semantics of JsKernel/VmKernel.
    __output__ = (0, eval)(${JSON.stringify(code)});
  } catch (e) {
    __error__ = e instanceof Error ? e.message : String(e);
  }

  // ── Flush console logs to stderr ───────────────────────────────────────────
  if (__logs__.length > 0) {
    writeStderr(__logs__.join("\\n") + "\\n");
  }

  // ── Build result envelope ──────────────────────────────────────────────────
  var __isFinalAnswer__ =
    typeof globalThis.__finalAnswer__ !== "undefined" ||
    typeof globalThis.__final_answer__ !== "undefined";
  var __fa__ =
    typeof globalThis.__finalAnswer__ !== "undefined"
      ? globalThis.__finalAnswer__
      : globalThis.__final_answer__;

  if (__error__ !== null) {
    writeStdout(JSON.stringify({ output: null, isFinalAnswer: false, error: __error__ }) + "\\n");
  } else {
    writeStdout(JSON.stringify({
      output: __output__,
      isFinalAnswer: __isFinalAnswer__,
      finalAnswer: __isFinalAnswer__ ? __fa__ : undefined,
    }) + "\\n");
  }

  // ── Persist updated state bag ──────────────────────────────────────────────
  var __reserved__ = {
    __state__: 1, __k__: 1, __logs__: 1, __output__: 1, __error__: 1,
    __isFinalAnswer__: 1, __fa__: 1, __allowed_hosts__: 1,
    __finalAnswer__: 1, __final_answer__: 1, console: 1, fetch: 1,
    Javy: 1, globalThis: 1, undefined: 1, Infinity: 1, NaN: 1,
    JSON: 1, Math: 1, Object: 1, Array: 1, String: 1, Number: 1,
    Boolean: 1, Error: 1, TypeError: 1, RangeError: 1, Promise: 1,
    Map: 1, Set: 1, WeakMap: 1, WeakSet: 1, Symbol: 1, BigInt: 1,
    Date: 1, RegExp: 1, Function: 1, eval: 1, parseInt: 1, parseFloat: 1,
    isNaN: 1, isFinite: 1, encodeURIComponent: 1, decodeURIComponent: 1,
    URL: 1, URLSearchParams: 1, TextEncoder: 1, TextDecoder: 1,
  };
  var __newState__ = {};
  try {
    var __keys__ = Object.keys(globalThis);
    for (var __i__ = 0; __i__ < __keys__.length; __i__++) {
      var __key__ = __keys__[__i__];
      if (__reserved__[__key__]) continue;
      if (__key__.startsWith("__") && __key__.endsWith("__")) continue;
      var __val__ = globalThis[__key__];
      if (typeof __val__ === "function" || typeof __val__ === "symbol") continue;
      try {
        __newState__[__key__] = JSON.stringify(__val__);
      } catch (_) {}
    }
  } catch (_) {}
  writeStdout(JSON.stringify(__newState__) + "\\n");

})();
`;
}

// ─── WASM runner (node:wasi + WebAssembly) ────────────────────────────────────

/**
 * Instantiate and run a WASI-compiled WASM module using Node's built-in WebAssembly API.
 *
 * stdin carries the state bag JSON; stdout receives the result envelope + new state bag.
 * stderr receives console.log output.
 *
 * WebAssembly types come from lib.dom.d.ts which is excluded in this Node-only package.
 * We access the WebAssembly global via `globalThis` cast through `unknown` to avoid
 * the DOM lib dependency.
 */
export async function runWasm(
  wasmPath: string,
  stdinData: string
): Promise<{ stdout: string; stderr: string; newState: Record<string, string> }> {
  const wasmBytes = await readFile(wasmPath);

  const WA = (globalThis as unknown as { WebAssembly: WasmAPI }).WebAssembly;

  const stdinBuffer = new TextEncoder().encode(stdinData);
  let stdinOffset = 0;

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

  const wasi = new WASI({
    version: "preview1",
    // No filesystem preopens — deny-all by default.
    preopens: {},
  });

  const wasmModule = await WA.compile(wasmBytes);

  // Merge WASI imports, then override fd_read/fd_write to capture I/O.
  const baseImports = wasi.getImportObject() as Record<string, Record<string, unknown>>;
  const wasiSnapshotPreview1 = { ...baseImports.wasi_snapshot_preview1 };

  // fd_read(fd, iovs_ptr, iovs_len, nread_ptr) → errno
  wasiSnapshotPreview1.fd_read = (
    fd: number,
    iovs_ptr: number,
    iovs_len: number,
    nread_ptr: number
  ): number => {
    if (fd !== 0) return 8; // EBADF for non-stdin fds
    const mem = new DataView(getMemoryBuffer(instance));
    let totalRead = 0;
    for (let i = 0; i < iovs_len; i++) {
      const iov_base = mem.getUint32(iovs_ptr + i * 8, true);
      const iov_len = mem.getUint32(iovs_ptr + i * 8 + 4, true);
      const available = stdinBuffer.length - stdinOffset;
      const toCopy = Math.min(iov_len, available);
      if (toCopy === 0) break;
      new Uint8Array(mem.buffer).set(
        stdinBuffer.subarray(stdinOffset, stdinOffset + toCopy),
        iov_base
      );
      stdinOffset += toCopy;
      totalRead += toCopy;
    }
    mem.setUint32(nread_ptr, totalRead, true);
    return 0; // ESUCCESS
  };

  // fd_write(fd, iovs_ptr, iovs_len, nwritten_ptr) → errno
  wasiSnapshotPreview1.fd_write = (
    fd: number,
    iovs_ptr: number,
    iovs_len: number,
    nwritten_ptr: number
  ): number => {
    const mem = new DataView(getMemoryBuffer(instance));
    let totalWritten = 0;
    for (let i = 0; i < iovs_len; i++) {
      const iov_base = mem.getUint32(iovs_ptr + i * 8, true);
      const iov_len = mem.getUint32(iovs_ptr + i * 8 + 4, true);
      const chunk = new Uint8Array(mem.buffer, iov_base, iov_len).slice();
      if (fd === 1) stdoutChunks.push(chunk);
      else if (fd === 2) stderrChunks.push(chunk);
      totalWritten += iov_len;
    }
    mem.setUint32(nwritten_ptr, totalWritten, true);
    return 0;
  };

  // Declare `instance` before the closures above so fd_read/fd_write can reference it
  // at call time. wasi.start() fires during WebAssembly._start, after instantiation.
  let instance!: WasmInstance;
  instance = await WA.instantiate(wasmModule, {
    ...baseImports,
    wasi_snapshot_preview1: wasiSnapshotPreview1,
  } as Record<string, Record<string, WasmImportValue>>);

  try {
    wasi.start(instance as WasmInstance);
  } catch (err) {
    // WASI programs exit via proc_exit, which throws in Node — expected behaviour.
    const code = (err as { code?: number }).code;
    if (typeof code === "number" && code !== 0) {
      throw new Error(`WasmtimeKernel: WASM exited with code ${code}`);
    }
    // proc_exit(0) — normal completion, fall through.
  }

  const decoder = new TextDecoder();
  const stdout = decoder.decode(concatUint8Arrays(stdoutChunks));
  const stderr = decoder.decode(concatUint8Arrays(stderrChunks));

  // Harness emits two JSON lines: result envelope + updated state bag.
  const lines = stdout.trim().split("\n").filter(Boolean);
  const envelopeLine = lines[0] ?? "{}";
  const stateLine = lines[1] ?? "{}";

  let newState: Record<string, string> = {};
  try {
    newState = JSON.parse(stateLine) as Record<string, string>;
  } catch {
    // Non-fatal: cross-run state is lost for this step.
  }

  const envelope = JSON.parse(envelopeLine) as { error?: string };
  if (envelope.error) {
    throw new Error(`KernelError: ${envelope.error}`);
  }

  return { stdout: envelopeLine, stderr, newState };
}

// ─── Minimal WebAssembly type aliases (avoids DOM lib dependency) ─────────────

type WasmImportValue = unknown;

interface WasmInstance {
  exports: Record<string, unknown>;
}

interface WasmModule {
  readonly _brand?: unique symbol;
}

interface WasmAPI {
  compile(bytes: ArrayBuffer | Uint8Array): Promise<WasmModule>;
  instantiate(
    module: WasmModule,
    imports: Record<string, Record<string, WasmImportValue>>
  ): Promise<WasmInstance>;
}

function getMemoryBuffer(instance: WasmInstance): ArrayBuffer {
  const mem = instance.exports.memory;
  if (!mem || typeof (mem as { buffer?: ArrayBuffer }).buffer === "undefined") {
    throw new Error("WasmtimeKernel: WASM module does not export 'memory'");
  }
  return (mem as { buffer: ArrayBuffer }).buffer;
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
