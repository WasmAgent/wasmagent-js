/**
 * A2 — DevTools fork-from-step demo.
 *
 * No model calls; uses a synthetic event trace so the example is offline,
 * deterministic, and doubles as a smoke test for the replay engine.
 *
 * Shows:
 *   1. Build a fake LoggedEvent stream (the same shape EventLog.tap yields).
 *   2. Construct an EventLogReplay over it.
 *   3. Inspect step boundaries and the cursor at various positions.
 *   4. Fork from step 2 with a model override; print the resulting bundle.
 */
import { EventLog, MapKvBackend } from "@wasmagent/core";
import { EventLogReplay } from "@wasmagent/devtools";

// ── 1. Pretend we just ran an agent and recorded events ─────────────────────

const TRACE_ID = "demo-trace-1";
const kv = new MapKvBackend();
const log = new EventLog(kv);

async function* fakeAgentRun() {
  yield { traceId: TRACE_ID, parentTraceId: null, channel: "text", event: "run_start", data: { task: "ship feature X" }, timestampMs: 0 };
  yield { traceId: TRACE_ID, parentTraceId: null, channel: "text", event: "step_start", data: { step: 1 }, timestampMs: 1 };
  yield { traceId: TRACE_ID, parentTraceId: null, channel: "tool", event: "tool_call_start", data: { toolName: "read_file", input: { path: "src/foo.ts" } }, timestampMs: 2 };
  yield { traceId: TRACE_ID, parentTraceId: null, channel: "tool", event: "tool_call_end", data: { toolName: "read_file", output: "// contents…" }, timestampMs: 3 };
  yield { traceId: TRACE_ID, parentTraceId: null, channel: "text", event: "step_start", data: { step: 2 }, timestampMs: 4 };
  yield { traceId: TRACE_ID, parentTraceId: null, channel: "text", event: "model_done", data: { inputTokens: 120, outputTokens: 30 }, timestampMs: 5 };
  yield { traceId: TRACE_ID, parentTraceId: null, channel: "text", event: "step_start", data: { step: 3 }, timestampMs: 6 };
  yield { traceId: TRACE_ID, parentTraceId: null, channel: "text", event: "final_answer", data: { answer: "shipped feature X via patch_file" }, timestampMs: 7 };
}

const collected = [];
for await (const tagged of log.tap(fakeAgentRun(), TRACE_ID)) {
  collected.push(tagged);
}

console.log(`Recorded ${collected.length} events under traceId=${TRACE_ID}`);

// ── 2. Replay them through the engine ──────────────────────────────────────

// Both packages re-export the same engine class; either import works.
// The /devtools entry is the canonical one for tooling consumers.
const replay = new EventLogReplay(collected, { traceId: TRACE_ID });
console.log(`stepCount=${replay.stepCount} eventCount=${replay.eventCount}`);

// Cursor at step 0 — only the run_start preamble.
const atZero = replay.select(0);
console.log("select(0):", atZero.prefixEvents.map((e) => e.event.event));

// Cursor at step 2 — through model_done.
const atTwo = replay.select(2);
console.log("select(2):", atTwo.prefixEvents.map((e) => e.event.event));

// Final cursor surfaces the answer.
const atEnd = replay.select(replay.stepCount);
console.log("finalAnswer:", atEnd.finalAnswer);

// ── 3. Fork at step 2 with a model override ────────────────────────────────

const fork = replay.forkAt(2, {
  task: "Re-do step 3 — but use claude-haiku and aim for a one-line summary",
  modelId: "claude-haiku-4-5",
  note: "investigating verbose output",
});

console.log("\nFork bundle:");
console.log(`  forkedAtStep:    ${fork.forkedAtStep}`);
console.log(`  forkedAtEventId: ${fork.forkedAtEventId}`);
console.log(`  prefixEvents:    ${fork.prefixEvents.length}`);
console.log("  meta:           ", fork.meta);

// In a real app the next step would be:
//   await fetch("/run", { body: JSON.stringify({
//     task: fork.meta.task,
//     modelId: fork.meta.modelId,
//     replayEvents: fork.prefixEvents,
//   })});
// The bscode worker's POST /run doesn't yet accept replayEvents — feeding
// a prefix into a fresh MessageAssembler is a host-side concern.
