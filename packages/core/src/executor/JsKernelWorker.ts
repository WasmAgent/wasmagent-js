/**
 * JsKernel worker thread — runs inside a worker_threads Worker.
 *
 * Receives { type: "run", code, capabilities?, serial } messages, executes code
 * in a vm sandbox, and notifies the host via SharedArrayBuffer.
 *
 * The host passes capability allow-lists as plain JSON-serialisable arrays.
 * The worker calls buildCapabilityGlobals() to construct the actual capability
 * globals (including sandboxed fetch and __fs__) from those lists.
 */

import { parentPort, workerData } from "node:worker_threads";
import { createContext, Script } from "node:vm";
import { buildCapabilityGlobals } from "./capabilities.js";
import type { CapabilityManifest } from "./types.js";

const { sab } = workerData as { sab: SharedArrayBuffer };
const notifyBuf = new Int32Array(sab);

// ── sandbox ───────────────────────────────────────────────────────────────────

const logs: string[] = [];
const logCapture = (...args: unknown[]) => logs.push(args.map(String).join(" "));

const sandbox = createContext({
  console: { log: logCapture, warn: logCapture, error: logCapture },
  Math, JSON, Array, Object, String, Number, Boolean, Promise, Map, Set, Error, TypeError,
  __finalAnswer__: undefined as unknown,
});

// ── message loop ──────────────────────────────────────────────────────────────

parentPort!.on("message", async (msg: {
  type: "run";
  code: string;
  capabilities?: Partial<CapabilityManifest>;
  serial: number;
}) => {
  logs.length = 0;
  sandbox["__finalAnswer__"] = undefined;

  // Apply capability globals using the same buildCapabilityGlobals used by V8WasmKernel.
  // The worker runs in full Node.js context so it can build fetch closures and __fs__ objects.
  if (msg.capabilities) {
    const capGlobals = buildCapabilityGlobals(msg.capabilities);
    for (const [k, v] of Object.entries(capGlobals)) {
      sandbox[k] = v;
    }
  } else {
    // Remove any capability globals from a previous run.
    delete sandbox["fetch"];
    delete sandbox["__fs__"];
  }

  try {
    const script = new Script(msg.code, { filename: "agent-step.js" });
    let output = script.runInContext(sandbox);

    // If the code returned a Promise (e.g. __fs__.readFile(...)), await it so the
    // resolved value (string/void) can be structured-cloned back to the host.
    if (output instanceof Promise || (output !== null && typeof output === "object" && typeof (output as {then?: unknown}).then === "function")) {
      output = await (output as Promise<unknown>);
    }

    const finalAnswer = sandbox["__finalAnswer__"] as unknown;
    const isFinalAnswer = finalAnswer !== undefined;

    parentPort!.postMessage({
      type: "result",
      serial: msg.serial,
      output: isFinalAnswer ? finalAnswer : output,
      logs: [...logs],
      isFinalAnswer,
    });
  } catch (err) {
    parentPort!.postMessage({
      type: "error",
      serial: msg.serial,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  Atomics.store(notifyBuf, 0, msg.serial);
  Atomics.notify(notifyBuf, 0);
});
