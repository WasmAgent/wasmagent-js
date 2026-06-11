/**
 * Durable runtime — kill-and-resume demo.
 *
 * Exercises three primitives end-to-end with a synthetic agent stream:
 *   1. CheckpointableRun + KvCheckpointer persists snapshots to a shared KV.
 *   2. EventLog tags every event with a monotonic id, so a new client can
 *      reconnect with Last-Event-ID and replay only the missing tail.
 *   3. await_human_input causes the run to suspend; resumeFromHuman()
 *      submits the response in a fresh "process".
 *
 * No model calls, no external services — everything is in-memory and
 * deterministic, so the example doubles as a smoke test for the runtime
 * primitives.
 */
import {
  applyHumanResponse,
  CheckpointableRun,
  EventLog,
  KvCheckpointer,
  MapKvBackend,
  MessageAssembler,
  resumeFromHuman,
  restoreFromSnapshot,
} from "@agentkit-js/core";

// ── Shared KV across the whole demo ──────────────────────────────────────────
// Same backend powers checkpoints AND the SSE event log — that's the A4 gate
// in action: one canonical KvBackend, three uses.
const kv = new MapKvBackend();
const checkpointer = new KvCheckpointer(kv);
const log = new EventLog(kv);

// ── Synthetic agent — emits step_start events, then pauses for HITL ──────────
async function* fakeAgent(steps) {
  for (let i = 0; i < steps; i++) {
    yield {
      traceId: "demo-trace",
      parentTraceId: null,
      timestampMs: Date.now(),
      channel: "thinking",
      event: "step_start",
      data: { step: i },
    };
    if (i === 2) {
      yield {
        traceId: "demo-trace",
        parentTraceId: null,
        timestampMs: Date.now(),
        channel: "status",
        event: "await_human_input",
        data: { promptId: "approve", prompt: "Continue past step 2?", step: i },
      };
      return; // simulate suspend point
    }
  }
}

async function* finishingAgent() {
  yield {
    traceId: "demo-trace",
    parentTraceId: null,
    timestampMs: Date.now(),
    channel: "thinking",
    event: "step_start",
    data: { step: 3 },
  };
  yield {
    traceId: "demo-trace",
    parentTraceId: null,
    timestampMs: Date.now(),
    channel: "text",
    event: "final_answer",
    data: { answer: "complete" },
  };
}

// ── PROCESS 1: run until pause, persist everything ───────────────────────────
console.log("── Process 1: run, then suspend on await_human_input ──");
{
  const asm = new MessageAssembler({ systemPrompt: "demo", toolsSchema: [] });
  asm.addStep({ type: "user_message", content: "demo task" });
  const run = new CheckpointableRun({ checkpointer }, asm);

  // Tap through the EventLog so the SSE wire format is identical to what a
  // real worker would emit.
  let lastSeen = null;
  for await (const { eventId, event } of log.tap(
    run.run(fakeAgent(5), "demo task", "demo-trace"),
    "demo-trace"
  )) {
    console.log(`  id=${eventId} event=${event.event}`);
    lastSeen = eventId;
  }
  console.log(`  → suspended; lastSeen = ${lastSeen}\n`);
}

// ── PROCESS 2: an HTTP endpoint receives the human response ──────────────────
console.log("── Process 2: operator submits human response ──");
{
  // Brand-new checkpointer wrapping the same KV — proves nothing leaks across
  // process boundaries except what's persisted.
  const cp2 = new KvCheckpointer(kv);
  const ok = await resumeFromHuman(cp2, "demo-trace", "approve", "yes");
  console.log(`  resumeFromHuman → ${ok}\n`);
}

// ── PROCESS 3: a fresh worker picks up the trace and finishes the run ───────
console.log("── Process 3: fresh worker resumes the run ──");
{
  const cp3 = new KvCheckpointer(kv);
  const log3 = new EventLog(kv);
  const snap = await cp3.load("demo-trace");
  if (!snap) throw new Error("no snapshot found — should never happen");

  const asm = new MessageAssembler({ systemPrompt: "demo", toolsSchema: [] });
  restoreFromSnapshot(snap, asm);
  applyHumanResponse(snap, asm); // human's "yes" lands as a user_message in history

  // Replay everything the previous client already saw, then keep streaming live.
  // For demo purposes we replay from the start; in production the client
  // sends Last-Event-ID and we'd pass it to log3.replay().
  console.log("  Replay:");
  for await (const { eventId, event } of log3.replay("demo-trace")) {
    console.log(`    id=${eventId} event=${event.event}`);
  }

  console.log("  Live tail:");
  const startSeq = await log3.nextSeq("demo-trace");
  const run = new CheckpointableRun({ checkpointer: cp3 }, asm);
  for await (const { eventId, event } of log3.tap(
    run.run(finishingAgent(), snap.task, "demo-trace"),
    "demo-trace",
    { startSeq }
  )) {
    console.log(`    id=${eventId} event=${event.event}`);
  }
}

console.log("\n✅ Run completed end-to-end across three simulated processes.");
