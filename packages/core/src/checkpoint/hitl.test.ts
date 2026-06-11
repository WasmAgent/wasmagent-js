/**
 * A3 — HITL persisted suspend/resume e2e test.
 *
 * Verifies the runtime contract:
 *   1. An agent emits `await_human_input`; CheckpointableRun persists the
 *      snapshot with `pendingHumanInput` and exits the iterator.
 *   2. The 'process' is dropped — only the persistent KV survives.
 *   3. resumeFromHuman() in a fresh process marks the snapshot ready.
 *   4. restoreFromSnapshot + applyHumanResponse rebuild the assembler so a
 *      brand-new agent loop sees the response in its history.
 */

import { describe, expect, it } from "vitest";
import {
  applyHumanResponse,
  CheckpointableRun,
  KvCheckpointer,
  resumeFromHuman,
  restoreFromSnapshot,
} from "../index.js";
import { MapKvBackend } from "../memory/MemoryTool.js";
import { MessageAssembler } from "../memory/MessageAssembler.js";
import type { AgentEvent } from "../types/events.js";

function ev(partial: Partial<AgentEvent> & { event: string }): AgentEvent {
  return {
    traceId: "t",
    parentTraceId: null,
    timestampMs: 1000,
    channel: "thinking",
    ...partial,
  } as AgentEvent;
}

describe("A3 — HITL persisted suspend/resume", () => {
  it("await_human_input persists pendingHumanInput and stops the run", async () => {
    const sharedKv = new MapKvBackend();
    const cp = new KvCheckpointer(sharedKv);

    async function* paused(): AsyncGenerator<AgentEvent> {
      yield ev({ event: "step_start", channel: "thinking", data: { step: 0 } as never });
      yield ev({
        event: "await_human_input",
        channel: "status",
        data: { promptId: "p1", prompt: "Approve PR?", step: 1 } as never,
      });
      // anything after must NEVER be reached — the wrapper exits on await_human_input.
      yield ev({
        event: "final_answer",
        channel: "text",
        data: { answer: "should-not-reach" } as never,
      });
    }

    const asm = new MessageAssembler({ systemPrompt: "test", toolsSchema: [] });
    asm.addStep({ type: "user_message", content: "do thing" });
    const run = new CheckpointableRun({ checkpointer: cp }, asm);

    const events: AgentEvent[] = [];
    for await (const e of run.run(paused(), "do thing", "trace-pause")) {
      events.push(e);
    }
    // Saw step_start + await_human_input then stopped.
    expect(events.map((e) => e.event)).toEqual(["step_start", "await_human_input"]);

    // Snapshot persisted with pendingHumanInput.
    const snap = await cp.load("trace-pause");
    expect(snap?.pendingHumanInput).toEqual({ promptId: "p1", prompt: "Approve PR?" });
    expect(snap?.humanResponse).toBeUndefined();
  });

  it("resumeFromHuman in a fresh process marks the snapshot ready", async () => {
    // PROCESS 1 — pause and exit.
    const sharedKv = new MapKvBackend();
    const cp1 = new KvCheckpointer(sharedKv);
    async function* paused(): AsyncGenerator<AgentEvent> {
      yield ev({ event: "step_start", channel: "thinking", data: { step: 0 } as never });
      yield ev({
        event: "await_human_input",
        channel: "status",
        data: { promptId: "p1", prompt: "Approve?", step: 1 } as never,
      });
    }
    const asm1 = new MessageAssembler({ systemPrompt: "test", toolsSchema: [] });
    asm1.addStep({ type: "user_message", content: "task" });
    const run1 = new CheckpointableRun({ checkpointer: cp1 }, asm1);
    for await (const _ of run1.run(paused(), "task", "trace-A3")) { /* drain */ }

    // ── Drop everything but sharedKv to model a process boundary. ──────────

    // PROCESS 2 — operator submits the human response via a fresh checkpointer.
    const cp2 = new KvCheckpointer(sharedKv);
    const ok = await resumeFromHuman(cp2, "trace-A3", "p1", "approve");
    expect(ok).toBe(true);

    // ── Drop process 2. ─────────────────────────────────────────────────────

    // PROCESS 3 — agent worker resumes. Loads snapshot, rebuilds assembler,
    // sees the human response in history, and continues with a fresh agent loop.
    const cp3 = new KvCheckpointer(sharedKv);
    const snap = await cp3.load("trace-A3");
    expect(snap).not.toBeNull();
    expect(snap?.humanResponse).toEqual({ promptId: "p1", response: "approve" });

    const asm3 = new MessageAssembler({ systemPrompt: "test", toolsSchema: [] });
    if (snap) {
      restoreFromSnapshot(snap, asm3);
      applyHumanResponse(snap, asm3);
    }
    // The last user_message in the assembler must be the human response.
    const last = asm3.steps[asm3.steps.length - 1];
    expect(last).toMatchObject({ type: "user_message", content: "approve" });

    // Continue the run from this point.
    async function* resumed(): AsyncGenerator<AgentEvent> {
      yield ev({ event: "step_start", channel: "thinking", data: { step: 2 } as never });
      yield ev({
        event: "final_answer",
        channel: "text",
        data: { answer: "merged" } as never,
      });
    }
    const run3 = new CheckpointableRun({ checkpointer: cp3 }, asm3);
    const evs: AgentEvent[] = [];
    for await (const e of run3.run(resumed(), "task", "trace-A3")) evs.push(e);
    expect(evs.map((e) => e.event)).toEqual(["step_start", "final_answer"]);

    // final_answer purges the snapshot.
    expect(await cp3.load("trace-A3")).toBeNull();
  });

  it("resumeFromHuman returns false when no snapshot exists", async () => {
    const cp = new KvCheckpointer(new MapKvBackend());
    expect(await resumeFromHuman(cp, "missing", "p1", "x")).toBe(false);
  });

  it("resumeFromHuman returns false when snapshot is not in awaiting state", async () => {
    const sharedKv = new MapKvBackend();
    const cp = new KvCheckpointer(sharedKv);
    await cp.save("t", {
      traceId: "t",
      task: "t",
      history: [],
      stepIndex: 0,
      savedAtMs: 0,
    });
    expect(await resumeFromHuman(cp, "t", "p1", "x")).toBe(false);
  });

  it("resumeFromHuman rejects mismatched promptId", async () => {
    const sharedKv = new MapKvBackend();
    const cp = new KvCheckpointer(sharedKv);
    await cp.save("t", {
      traceId: "t",
      task: "t",
      history: [],
      stepIndex: 0,
      savedAtMs: 0,
      pendingHumanInput: { promptId: "expected", prompt: "?" },
    });
    expect(await resumeFromHuman(cp, "t", "wrong", "x")).toBe(false);
    // No write happened — humanResponse is still undefined.
    const snap = await cp.load("t");
    expect(snap?.humanResponse).toBeUndefined();
  });
});
