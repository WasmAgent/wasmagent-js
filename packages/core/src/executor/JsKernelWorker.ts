/**
 * JsKernel worker thread — runs inside a worker_threads Worker.
 *
 * Receives { type: "run", code, capabilities?, serial } messages, executes code
 * in a vm sandbox, and sends results back via parentPort.postMessage.
 *
 * Synchronisation with the host is entirely through the structured-clone message
 * channel — no SharedArrayBuffer or Atomics are used.
 *
 * The worker runs in full Node.js context so it can build real capability globals
 * (sandboxed fetch, __fs__ with path enforcement) via buildCapabilityGlobals().
 *
 * Q3 — message handler reentrancy:
 *   EventEmitter does NOT serialise async handlers. If two messages arrived while
 *   an async handler was awaiting, the second handler's synchronous prefix would
 *   run during the first handler's await — corrupting shared module-level state
 *   (logs, sandbox sentinels).
 *   This is safe TODAY because the host never sends a second message to the same
 *   worker before the first completes (protocol guarantee in JsKernel.ts), but as
 *   a defensive measure all mutable state is localised inside each handler invocation:
 *   - `localLogs` replaces the module-level `logs` array
 *   - `sandbox["__finalAnswer__"]` is reset at the top and read before any await
 *   This means a hypothetical reentrancy would produce wrong output (mixed logs)
 *   but would not silently produce correct-looking corrupted results.
 */

import { createContext, Script } from "node:vm";
import { parentPort } from "node:worker_threads";
import { buildCapabilityGlobals } from "./capabilities.js";
import type { CapabilityManifest } from "./types.js";

// ── sandbox ───────────────────────────────────────────────────────────────────
// Sandbox is module-level so vm variables persist across run() calls (stateful kernel).
// Only __finalAnswer__ and capability globals are written per-call; everything else
// (user variables) intentionally persists.

const sandbox = createContext({
  console: {
    // log is replaced per-call to write to the local log array (see handler below).
    log: (..._args: unknown[]) => {},
    warn: (..._args: unknown[]) => {},
    error: (..._args: unknown[]) => {},
  },
  Math,
  JSON,
  Array,
  Object,
  String,
  Number,
  Boolean,
  Promise,
  Map,
  Set,
  Error,
  TypeError,
  // Q5: both camelCase (JS convention) and snake_case (Python convention) sentinels
  // are recognised so agent code can use either spelling regardless of which kernel
  // backend is active. Setting either one signals a final answer.
  __finalAnswer__: undefined as unknown,
  __final_answer__: undefined as unknown,
});

// ── message loop ──────────────────────────────────────────────────────────────

parentPort?.on(
  "message",
  async (msg: {
    type: "run";
    code: string;
    capabilities?: Partial<CapabilityManifest>;
    serial: number;
    timeoutMs?: number;
  }) => {
    // Q3: localise per-call mutable state to avoid pollution if handlers ever overlap.
    const localLogs: string[] = [];
    const logCapture = (...args: unknown[]) => localLogs.push(args.map(String).join(" "));
    sandbox.console = { log: logCapture, warn: logCapture, error: logCapture };

    sandbox.__finalAnswer__ = undefined;
    sandbox.__final_answer__ = undefined;

    // Apply capability globals using buildCapabilityGlobals (same as VmKernel).
    // Always clear capability globals first so a truthy-but-empty manifest ({})
    // does not leave capabilities from the previous call in the sandbox.
    delete sandbox.fetch;
    delete sandbox.__fs__;
    if (msg.capabilities) {
      const capGlobals = buildCapabilityGlobals(msg.capabilities);
      for (const [k, v] of Object.entries(capGlobals)) {
        sandbox[k] = v;
      }
    }

    try {
      const script = new Script(msg.code, { filename: "agent-step.js" });
      let output = script.runInContext(sandbox, { timeout: msg.timeoutMs });

      // If the code returned a Promise (e.g. __fs__.readFile(...)), await it so the
      // resolved value can be structured-cloned back to the host.
      if (
        output instanceof Promise ||
        (output !== null &&
          typeof output === "object" &&
          typeof (output as { then?: unknown }).then === "function")
      ) {
        output = await (output as Promise<unknown>);
      }

      // Q5: check both spellings — camelCase (JS convention) and snake_case (Python convention).
      // Setting either one signals a final answer, so agent code works regardless of kernel backend.
      const finalAnswerCamel = sandbox.__finalAnswer__ as unknown;
      const finalAnswerSnake = sandbox.__final_answer__ as unknown;
      const isFinalAnswer = finalAnswerCamel !== undefined || finalAnswerSnake !== undefined;
      const finalAnswer = finalAnswerCamel !== undefined ? finalAnswerCamel : finalAnswerSnake;

      // Q3 — __finalAnswer__ async contract:
      // Agent code that sets __finalAnswer__ inside an async callback that is NOT
      // awaited or returned will NOT be detected here. Only two patterns are safe:
      //   (a) Synchronous: `__finalAnswer__ = value;`
      //   (b) Async via returned Promise: `return somePromise.then(r => { __finalAnswer__ = r; })`
      //       or `async function main() { __finalAnswer__ = await x; } main()` — the
      //       returned Promise resolves *after* the assignment, so the worker's await above
      //       guarantees the value is visible.
      // Fire-and-forget patterns (setTimeout, bare .then not returned, unhandled Promises)
      // will NOT set __finalAnswer__ in time. This is documented as a design constraint,
      // not a bug to fix — detecting detached async tasks would require draining the entire
      // event loop, which is incompatible with bounded step execution and timeout semantics.

      parentPort?.postMessage({
        type: "result",
        serial: msg.serial,
        output: isFinalAnswer ? finalAnswer : output,
        logs: localLogs,
        isFinalAnswer,
      });
    } catch (err) {
      parentPort?.postMessage({
        type: "error",
        serial: msg.serial,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
);
