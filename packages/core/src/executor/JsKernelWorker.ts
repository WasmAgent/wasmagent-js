/**
 * JsKernel worker thread — runs inside a worker_threads Worker.
 *
 * Receives { type: "run", code, capabilities?, serial } messages, executes code
 * in a vm sandbox, and sends results back via parentPort.postMessage.
 *
 * Synchronisation with the host is entirely through the structured-clone message
 * channel — no SharedArrayBuffer or Atomics are used. The host's setImmediate
 * polling loop detects completion by receiving the postMessage reply.
 *
 * The worker runs in full Node.js context so it can build real capability globals
 * (sandboxed fetch, __fs__ with path enforcement) via buildCapabilityGlobals().
 */

import { parentPort } from "node:worker_threads";
import { createContext, Script } from "node:vm";
import { buildCapabilityGlobals } from "./capabilities.js";
import type { CapabilityManifest } from "./types.js";

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

  // Apply capability globals using buildCapabilityGlobals (same as V8WasmKernel).
  if (msg.capabilities) {
    const capGlobals = buildCapabilityGlobals(msg.capabilities);
    for (const [k, v] of Object.entries(capGlobals)) {
      sandbox[k] = v;
    }
  } else {
    // Remove any capability globals left from a previous run.
    delete sandbox["fetch"];
    delete sandbox["__fs__"];
  }

  try {
    const script = new Script(msg.code, { filename: "agent-step.js" });
    let output = script.runInContext(sandbox);

    // If the code returned a Promise (e.g. __fs__.readFile(...)), await it so the
    // resolved value can be structured-cloned back to the host.
    if (
      output instanceof Promise ||
      (output !== null && typeof output === "object" &&
        typeof (output as { then?: unknown }).then === "function")
    ) {
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
});
