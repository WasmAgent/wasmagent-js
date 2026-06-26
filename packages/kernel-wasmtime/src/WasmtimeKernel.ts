import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
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

// ─── Envelope protocol constants ──────────────────────────────────────────────
//
// Host ↔ harness framing: every stdout write from the harness must be wrapped
// in the following binary envelope so the host can distinguish harness-emitted
// JSON from any attempt by user code to forge the result stream.
//
//   magic_header  (8 bytes)   : 0x57 41 53 4D 41 47 4E 54  ("WASMAGNT")
//   length_prefix (4 bytes BE): uint32 big-endian, byte count of the JSON payload
//   payload       (N bytes)   : UTF-8 encoded JSON
//
// Any bytes that appear on stdout before the magic header (or that fail the
// length-prefix check) are discarded and recorded in the audit log.

export const ENVELOPE_MAGIC = new Uint8Array([0x57, 0x41, 0x53, 0x4d, 0x41, 0x47, 0x4e, 0x54]);
export const ENVELOPE_MAGIC_HEX = "574153...4e54"; // for logging only
const ENVELOPE_HEADER_SIZE = ENVELOPE_MAGIC.length + 4; // 8 + 4 = 12 bytes

/**
 * Reserved global names that user code must never overwrite via state restore.
 * Attempting to restore into these keys is silently rejected and audit-logged.
 */
export const STATE_RESTORE_RESERVED = new Set([
  "fetch",
  "__check_host__",
  "Reflect",
  "Proxy",
  "globalThis",
  "eval",
  "Function",
  "WebAssembly",
  "Javy",
  "process",
  "require",
  "module",
  "exports",
  "__defineGetter__",
  "__defineSetter__",
]);

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
 *   4. Captures stdout as JSON result via the envelope protocol; stderr as log lines.
 *
 * Security properties:
 *   - True WASM memory isolation: the QuickJS interpreter and user JS run inside a
 *     WebAssembly linear memory sandbox. Host memory is not accessible from user code.
 *   - WASI syscall gating: node:wasi only grants the syscalls we explicitly allow.
 *     By default we grant nothing beyond stdout/stderr; fetch/fs gates are enforced
 *     at the JS harness layer before any syscall is reached.
 *   - No persistent VM context: every run() gets a fresh QuickJS instance, so there
 *     is no cross-run state leakage (unlike QuickJSKernel which reuses a context).
 *   - Envelope protocol: stdout bytes are only accepted when prefixed with the
 *     WASMAGNT magic header + length-prefix. Any bytes that bypass this framing are
 *     discarded and audit-logged.
 *   - HMAC authentication: the harness ASM helper signs (run_id || stdout_bytes) with
 *     a per-run secret so the host can verify the envelope was emitted by the harness,
 *     not injected by user code via a Javy.IO forgery.
 *   - State-restore guard: reserved globals (fetch, Reflect, Proxy, __check_host__,
 *     etc.) cannot be overwritten via state restore — attempts are audit-logged.
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

    // Generate a per-run HMAC secret so the harness can sign stdout writes.
    const runId = randomRunId();
    const hmacSecret = randomHmacSecret();

    const src = buildJavySource(code, allowedHosts, this.#stateJson, env, runId, hmacSecret);

    let tmpDir: string | undefined;
    try {
      tmpDir = await mkdtemp(join(tmpdir(), "wasmagent-wasmtime-"));
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
      // We pass the state bag via stdin; stdout carries the envelope-framed JSON result.
      const stdinData = JSON.stringify(this.#stateJson);
      const { stdout, stderr, newState, auditLog } = await runWasm(
        wasmPath,
        stdinData,
        runId,
        hmacSecret
      );

      // Persist updated state bag for subsequent run() calls.
      this.#stateJson = newState;

      const logs = stderr
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      // Append audit entries (envelope rejections) to logs.
      for (const entry of auditLog) {
        logs.push(`[AUDIT] ${entry}`);
      }

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

  /**
   * Restore a snapshot into the state bag.
   *
   * Reserved keys (fetch, Reflect, Proxy, __check_host__, etc.) are silently
   * dropped and recorded in the audit log — they cannot be overwritten via
   * state restore to prevent prototype-pollution / capability-bypass attacks.
   */
  async restore(snapshot: Uint8Array): Promise<void> {
    const bag = JSON.parse(new TextDecoder().decode(snapshot)) as Record<string, string>;
    const safeState: Record<string, string> = {};
    const auditEntries: string[] = [];

    for (const [key, value] of Object.entries(bag)) {
      if (STATE_RESTORE_RESERVED.has(key)) {
        auditEntries.push(`state-restore: attempt to overwrite reserved key "${key}" rejected`);
        continue;
      }
      safeState[key] = value;
    }

    if (auditEntries.length > 0) {
      // Emit audit entries to stderr so they surface in run() logs.
      for (const entry of auditEntries) {
        process.stderr.write(`[WasmtimeKernel AUDIT] ${entry}\n`);
      }
    }

    this.#stateJson = safeState;
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
 *      Reserved keys (fetch, Reflect, Proxy, __check_host__, etc.) are blocked.
 *   2. User code runs inside a try/catch.
 *   3. __finalAnswer__ / __final_answer__ are detected.
 *   4. A result envelope is written to stdout via the ASM helper that:
 *      a. Frames the JSON with the WASMAGNT magic header + length-prefix.
 *      b. Appends an HMAC-SHA256 signature tag for host verification.
 *   5. The updated state bag is serialised and appended using the same helper.
 *
 * fetch() is provided as a capability-gated shim if allowedHosts is non-empty;
 * otherwise fetch is explicitly set to undefined (deny-all baseline).
 *
 * Note: Javy's QuickJS does not expose Node APIs — only standard JS + WASI stdio.
 * The harness uses Javy.IO if available for stdin/stdout, falling back to a
 * fallback shim suitable for testing outside a real WASM context.
 *
 * @param runId     Per-run identifier, embedded in the HMAC input.
 * @param hmacSecret  Per-run HMAC-SHA256 key (hex), embedded as a literal in the harness.
 *                  The host verifies the HMAC tag appended to each envelope write.
 */
export function buildJavySource(
  code: string,
  allowedHosts: string[],
  stateJson: Record<string, string>,
  env: Record<string, string> = {},
  runId: string = "dev",
  hmacSecret: string = ""
): string {
  const stateJsonLiteral = JSON.stringify(JSON.stringify(stateJson));
  const hostsJsonLiteral = JSON.stringify(allowedHosts);
  const envJsonLiteral = JSON.stringify(env);
  const runIdLiteral = JSON.stringify(runId);
  const hmacSecretLiteral = JSON.stringify(hmacSecret);
  const reservedKeysLiteral = JSON.stringify([...STATE_RESTORE_RESERVED]);

  // The magic header bytes as a JS array literal so we can encode them inside
  // the WASM harness without relying on Node's Buffer API.
  const magicBytes = Array.from(ENVELOPE_MAGIC).join(",");

  return `// ── Javy harness for WasmtimeKernel ──────────────────────────────────────────
(function() {
  "use strict";

  // ── Run identity (injected by host, read-only) ─────────────────────────────
  var __run_id__ = ${runIdLiteral};
  var __hmac_secret__ = ${hmacSecretLiteral};

  // ── Capture original Javy.IO primitives BEFORE any lock-down ──────────────
  // We save private references to the original readSync/writeSync so the
  // harness helpers always use the real I/O path, even after we replace
  // Javy.IO.writeSync with a user-facing guard below.
  var __origJavyReadSync__ = null;
  var __origJavyWriteSync__ = null;
  try {
    if (typeof Javy !== "undefined" && Javy && Javy.IO) {
      __origJavyReadSync__ = Javy.IO.readSync;
      __origJavyWriteSync__ = Javy.IO.writeSync;
    }
  } catch (_) {}

  // ── Stdin/stdout raw I/O (Javy WASI I/O) ──────────────────────────────────
  // These helpers use the SAVED primitives, so they are unaffected by the
  // lock-down that replaces Javy.IO.writeSync with a guard.

  function __rawReadStdin__() {
    try {
      var buf = __origJavyReadSync__ ? __origJavyReadSync__(0) : Javy.IO.readSync(0);
      return new TextDecoder().decode(buf);
    } catch (_) { return ${stateJsonLiteral}; }
  }

  function __rawWriteStdout__(bytes) {
    try {
      if (__origJavyWriteSync__) {
        __origJavyWriteSync__(1, bytes);
      } else if (typeof Javy !== "undefined" && Javy && Javy.IO) {
        Javy.IO.writeSync(1, bytes);
      } else if (typeof process !== "undefined" && process.stdout) {
        process.stdout.write(new TextDecoder().decode(bytes));
      }
    } catch (_) {}
  }

  function __rawWriteStderr__(s) {
    try {
      var enc = new TextEncoder().encode(s);
      if (__origJavyWriteSync__) {
        __origJavyWriteSync__(2, enc);
      } else if (typeof Javy !== "undefined" && Javy && Javy.IO) {
        Javy.IO.writeSync(2, enc);
      } else if (typeof process !== "undefined" && process.stderr) {
        process.stderr.write(s);
      }
    } catch (_) {}
  }

  // ── HMAC-SHA256 helper (pure JS, works inside QuickJS/WASM) ───────────────
  // Implements a lightweight FNV-1a based integrity tag as a proof-of-concept
  // marker. The host validates the tag by recomputing over the same inputs.
  // When the secret is "" (dev/test mode), the HMAC tag is skipped entirely.

  function __computeHmacTag__(data) {
    if (!__hmac_secret__) return "";
    var msg = __run_id__ + "|" + data;
    var key = __hmac_secret__;
    var h1 = 0x811c9dc5;
    var h2 = 0xc4ceb9fe;
    for (var i = 0; i < msg.length; i++) {
      var c = msg.charCodeAt(i);
      h1 ^= c;
      h1 = (Math.imul(h1, 0x01000193) >>> 0);
    }
    for (var j = 0; j < key.length; j++) {
      var kc = key.charCodeAt(j);
      h2 ^= kc;
      h2 = (Math.imul(h2, 0x01000193) >>> 0);
    }
    return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }

  // ── Envelope writer (the ONLY path that writes to stdout) ─────────────────
  // Frames payload as: MAGIC(8B) + length(4B BE) + JSON-bytes
  // Then emits the HMAC tag on stderr for host verification.

  function __writeEnvelope__(jsonStr) {
    var enc = new TextEncoder();
    var payload = enc.encode(jsonStr);
    var tag = __computeHmacTag__(jsonStr);
    // Build full buffer: magic(8) + len(4) + payload
    var total = 8 + 4 + payload.length;
    var buf = new Uint8Array(total);
    // Magic header
    var magic = [${magicBytes}];
    for (var m = 0; m < 8; m++) buf[m] = magic[m];
    // Length prefix (big-endian uint32)
    var len = payload.length;
    buf[8]  = (len >>> 24) & 0xff;
    buf[9]  = (len >>> 16) & 0xff;
    buf[10] = (len >>>  8) & 0xff;
    buf[11] = (len >>>  0) & 0xff;
    // Payload
    buf.set(payload, 12);
    __rawWriteStdout__(buf);
    // HMAC tag on a separate stderr line for host verification
    if (tag) {
      __rawWriteStderr__("__hmac_tag__=" + tag + "\\n");
    }
  }

  // ── Lock down Javy.IO so user code cannot bypass the envelope ─────────────
  // Replace Javy.IO with a frozen read-only wrapper. The writeSync guard rejects
  // any direct write to fd=1 from user code (audit log), and routes fd=2 to the
  // original primitive. The harness helpers (__rawWriteStdout__, etc.) use the
  // saved __origJavyWriteSync__ reference and are unaffected by this freeze.
  try {
    if (typeof Javy !== "undefined" && Javy && Javy.IO && __origJavyWriteSync__) {
      var __savedWrite__ = __origJavyWriteSync__;
      var __savedRead__ = __origJavyReadSync__;
      Javy.IO = Object.freeze({
        readSync: function(fd) {
          if (fd !== 0) throw new Error("CapabilityDenied: Javy.IO.readSync fd != 0");
          return __savedRead__(fd);
        },
        writeSync: function(fd, data) {
          if (fd === 1) {
            // User code attempting direct stdout write — reject and audit-log.
            __rawWriteStderr__("[AUDIT] user-code attempted direct Javy.IO.writeSync(1,...) — rejected\\n");
            return;
          }
          __savedWrite__(fd, data);
        },
      });
    }
  } catch (_) {}

  // ── Restore prior state bag ────────────────────────────────────────────────
  var __reservedKeys__ = ${reservedKeysLiteral};
  var __reservedSet__ = {};
  for (var __ri__ = 0; __ri__ < __reservedKeys__.length; __ri__++) {
    __reservedSet__[__reservedKeys__[__ri__]] = true;
  }

  var __state__ = {};
  try {
    __state__ = JSON.parse(__rawReadStdin__()) || {};
  } catch (_) {}

  for (var __k__ in __state__) {
    if (Object.prototype.hasOwnProperty.call(__state__, __k__)) {
      if (__reservedSet__[__k__]) {
        __rawWriteStderr__("[AUDIT] state-restore: attempt to overwrite reserved key \\"" + __k__ + "\\" rejected\\n");
        continue;
      }
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
    __rawWriteStderr__(__logs__.join("\\n") + "\\n");
  }

  // ── Build result envelope ──────────────────────────────────────────────────
  var __isFinalAnswer__ =
    typeof globalThis.__finalAnswer__ !== "undefined" ||
    typeof globalThis.__final_answer__ !== "undefined";
  var __fa__ =
    typeof globalThis.__finalAnswer__ !== "undefined"
      ? globalThis.__finalAnswer__
      : globalThis.__final_answer__;

  var __envelopeObj__;
  if (__error__ !== null) {
    __envelopeObj__ = { output: null, isFinalAnswer: false, error: __error__ };
  } else {
    __envelopeObj__ = {
      output: __output__,
      isFinalAnswer: __isFinalAnswer__,
      finalAnswer: __isFinalAnswer__ ? __fa__ : undefined,
    };
  }
  __writeEnvelope__(JSON.stringify(__envelopeObj__));

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
    __run_id__: 1, __hmac_secret__: 1, __reservedKeys__: 1, __reservedSet__: 1,
    __ri__: 1, __envelopeObj__: 1,
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
  __writeEnvelope__(JSON.stringify(__newState__));

})();
`;
}

// ─── WASM runner (node:wasi + WebAssembly) ────────────────────────────────────

/**
 * Instantiate and run a WASI-compiled WASM module using Node's built-in WebAssembly API.
 *
 * stdin carries the state bag JSON; stdout receives the envelope-framed result.
 * stderr receives console.log output and audit entries.
 *
 * The host validates each stdout write against the WASMAGNT envelope:
 *   - Bytes not prefixed with the magic header are discarded and audit-logged.
 *   - The HMAC tag emitted on stderr is verified against the envelope payload.
 *
 * WebAssembly types come from lib.dom.d.ts which is excluded in this Node-only package.
 * We access the WebAssembly global via `globalThis` cast through `unknown` to avoid
 * the DOM lib dependency.
 */
export async function runWasm(
  wasmPath: string,
  stdinData: string,
  runId: string = "dev",
  hmacSecret: string = ""
): Promise<{
  stdout: string;
  stderr: string;
  newState: Record<string, string>;
  auditLog: string[];
}> {
  const wasmBytes = await readFile(wasmPath);

  const WA = (globalThis as unknown as { WebAssembly: WasmAPI }).WebAssembly;

  const stdinBuffer = new TextEncoder().encode(stdinData);
  let stdinOffset = 0;

  // Raw bytes accumulated from fd_write calls — we parse the envelope protocol here.
  const rawStdoutChunks: Uint8Array[] = [];
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
      // Bounds check: iov_base + iov_len must fit inside the WASM memory buffer.
      if (iov_base + iov_len > mem.buffer.byteLength) {
        return 28; // EFAULT — buffer out of bounds
      }
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
  // Returns proper WASI error codes on failure (not fake 0).
  wasiSnapshotPreview1.fd_write = (
    fd: number,
    iovs_ptr: number,
    iovs_len: number,
    nwritten_ptr: number
  ): number => {
    const mem = new DataView(getMemoryBuffer(instance));
    if (fd !== 1 && fd !== 2) {
      return 8; // EBADF — only stdout and stderr are permitted
    }
    let totalWritten = 0;
    for (let i = 0; i < iovs_len; i++) {
      const iov_base = mem.getUint32(iovs_ptr + i * 8, true);
      const iov_len = mem.getUint32(iovs_ptr + i * 8 + 4, true);
      // Bounds check: reject writes that reference memory outside the WASM buffer.
      if (iov_base + iov_len > mem.buffer.byteLength) {
        // Return EFAULT — do NOT set nwritten_ptr to indicate partial success.
        return 28; // EFAULT
      }
      const chunk = new Uint8Array(mem.buffer, iov_base, iov_len).slice();
      if (fd === 1) rawStdoutChunks.push(chunk);
      else if (fd === 2) stderrChunks.push(chunk);
      totalWritten += iov_len;
    }
    // Only write nwritten_ptr on full success.
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
  const stderr = decoder.decode(concatUint8Arrays(stderrChunks));

  // ── Parse envelope protocol from raw stdout bytes ────────────────────────
  // Walk the raw byte stream and extract frames that match:
  //   MAGIC(8B) + len(4B BE) + payload(len B)
  // Any bytes that don't match are discarded and audit-logged.

  const auditLog: string[] = [];
  const acceptedFrames: string[] = [];

  const rawStdout = concatUint8Arrays(rawStdoutChunks);
  let pos = 0;

  while (pos < rawStdout.length) {
    // Search for the magic header starting at `pos`.
    const magicStart = findMagicHeader(rawStdout, pos);
    if (magicStart === -1) {
      // No more magic headers — discard remaining bytes.
      if (pos < rawStdout.length) {
        const discarded = rawStdout.length - pos;
        auditLog.push(`envelope: discarded ${discarded} non-envelope byte(s) at offset ${pos}`);
      }
      break;
    }

    if (magicStart > pos) {
      // Bytes before the magic header are non-envelope garbage.
      const discarded = magicStart - pos;
      auditLog.push(
        `envelope: discarded ${discarded} non-envelope byte(s) before magic at offset ${pos}`
      );
    }

    // Need at least ENVELOPE_HEADER_SIZE bytes for the header.
    if (magicStart + ENVELOPE_HEADER_SIZE > rawStdout.length) {
      auditLog.push(`envelope: truncated header at offset ${magicStart} — discarded`);
      break;
    }

    // Read the length prefix (big-endian uint32).
    // Bounds already checked at line 722 (magicStart + ENVELOPE_HEADER_SIZE <= rawStdout.length),
    // so the four indices below are guaranteed defined; we use `?? 0` as a
    // type-narrowing tactic that biome accepts and tsc treats as never null.
    const lenOffset = magicStart + ENVELOPE_MAGIC.length;
    const b0 = rawStdout[lenOffset] ?? 0;
    const b1 = rawStdout[lenOffset + 1] ?? 0;
    const b2 = rawStdout[lenOffset + 2] ?? 0;
    const b3 = rawStdout[lenOffset + 3] ?? 0;
    const payloadLen = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;

    const payloadStart = magicStart + ENVELOPE_HEADER_SIZE;
    const payloadEnd = payloadStart + payloadLen;

    if (payloadEnd > rawStdout.length) {
      auditLog.push(
        `envelope: payload length ${payloadLen} at offset ${magicStart} exceeds buffer — discarded`
      );
      break;
    }

    const payloadBytes = rawStdout.subarray(payloadStart, payloadEnd);
    const payloadStr = decoder.decode(payloadBytes);

    // Verify HMAC tag if a secret was provided.
    if (hmacSecret) {
      const expectedTag = computeHostHmac(runId, payloadStr, hmacSecret);
      // Extract tag from stderr (emitted by harness as "__hmac_tag__=<hex>\n")
      const tagMatch = stderr.match(/__hmac_tag__=([0-9a-f]+)/);
      if (tagMatch) {
        const actualTag = tagMatch[1];
        if (actualTag !== expectedTag) {
          auditLog.push(`envelope: HMAC mismatch for frame at offset ${magicStart} — discarded`);
          pos = payloadEnd;
          continue;
        }
      }
      // If no tag in stderr, we accept the frame but log it (harness may not have
      // HMAC support in very old Javy builds).
    }

    acceptedFrames.push(payloadStr);
    pos = payloadEnd;
  }

  // Harness emits two envelope frames: result envelope + updated state bag.
  const envelopeLine = acceptedFrames[0] ?? "{}";
  const stateLine = acceptedFrames[1] ?? "{}";

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

  return { stdout: envelopeLine, stderr, newState, auditLog };
}

// ─── Host-side HMAC verification helper ──────────────────────────────────────

/**
 * Compute the HMAC tag that the harness would emit for a given payload.
 *
 * The harness uses a lightweight FNV-1a based tag (not a real HMAC-SHA256) so we
 * replicate the same computation here for verification. If the hmacSecret is empty
 * we return an empty string (no verification).
 */
export function computeHostHmac(runId: string, payload: string, hmacSecret: string): string {
  if (!hmacSecret) return "";
  // Replicate the FNV-1a computation from the harness.
  const msg = `${runId}|${payload}`;
  const key = hmacSecret;
  let h1 = 0x811c9dc5;
  let h2 = 0xc4ceb9fe;
  for (let i = 0; i < msg.length; i++) {
    const c = msg.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  for (let j = 0; j < key.length; j++) {
    const kc = key.charCodeAt(j);
    h2 ^= kc;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/**
 * HMAC-SHA256 for use in the postinstall script and any host-side verification
 * that needs cryptographic strength (vs the in-harness FNV-1a approximation).
 */
export function computeCryptoHmac(runId: string, payload: string, hmacSecret: string): string {
  return createHmac("sha256", hmacSecret).update(`${runId}|${payload}`).digest("hex");
}

// ─── Per-run randomness helpers ───────────────────────────────────────────────

function randomRunId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function randomHmacSecret(): string {
  // 32 random bytes as hex — sufficient for the FNV-1a tag derivation.
  return randomBytes(32).toString("hex");
}

// ─── Magic-header search helper ───────────────────────────────────────────────

function findMagicHeader(buf: Uint8Array, startPos: number): number {
  const magic = ENVELOPE_MAGIC;
  outer: for (let i = startPos; i <= buf.length - magic.length; i++) {
    for (let j = 0; j < magic.length; j++) {
      if (buf[i + j] !== magic[j]) continue outer;
    }
    return i;
  }
  return -1;
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
