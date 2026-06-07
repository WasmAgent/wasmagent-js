import { describe, it, expect } from "vitest";
import { InMemoryCheckpointer, CheckpointableRun } from "../checkpoint/index.js";
import { MessageAssembler } from "../memory/MessageAssembler.js";
import type { AgentEvent } from "../types/events.js";

function makeAssembler() {
  return new MessageAssembler({ systemPrompt: "test", toolsSchema: [] });
}

async function* simpleRun(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const ev of events) yield ev;
}

describe("InMemoryCheckpointer (B4)", () => {
  it("save and load returns the same snapshot", async () => {
    const cp = new InMemoryCheckpointer();
    const snapshot = { traceId: "t1", task: "test", history: [], stepIndex: 3, savedAtMs: 1000 };
    await cp.save("t1", snapshot);
    const loaded = await cp.load("t1");
    expect(loaded).toEqual(snapshot);
  });

  it("load returns null for unknown traceId", async () => {
    const cp = new InMemoryCheckpointer();
    expect(await cp.load("missing")).toBeNull();
  });

  it("delete removes the snapshot", async () => {
    const cp = new InMemoryCheckpointer();
    await cp.save("t1", { traceId: "t1", task: "x", history: [], stepIndex: 1, savedAtMs: 0 });
    await cp.delete("t1");
    expect(await cp.load("t1")).toBeNull();
  });

  it("respond sets humanResponse on the snapshot", async () => {
    const cp = new InMemoryCheckpointer();
    await cp.save("t1", {
      traceId: "t1", task: "x", history: [], stepIndex: 1, savedAtMs: 0,
      pendingHumanInput: { promptId: "p1", prompt: "Are you sure?" },
    });
    await cp.respond("t1", "p1", "yes");
    const loaded = await cp.load("t1");
    expect(loaded?.humanResponse).toEqual({ promptId: "p1", response: "yes" });
  });

  it("respond throws when promptId does not match", async () => {
    const cp = new InMemoryCheckpointer();
    await cp.save("t1", {
      traceId: "t1", task: "x", history: [], stepIndex: 1, savedAtMs: 0,
      pendingHumanInput: { promptId: "p1", prompt: "?" },
    });
    await expect(cp.respond("t1", "wrong-id", "yes")).rejects.toThrow(/promptId mismatch/);
  });
});

describe("CheckpointableRun (B4)", () => {
  it("saves checkpoint after step_start events", async () => {
    const cp = new InMemoryCheckpointer();
    const assembler = makeAssembler();
    const wrapper = new CheckpointableRun({ checkpointer: cp }, assembler);

    const events: AgentEvent[] = [
      { traceId: "t1", parentTraceId: null, channel: "text", event: "run_start", data: { task: "do x" }, timestampMs: 0 },
      { traceId: "t1", parentTraceId: null, channel: "thinking", event: "step_start", data: { step: 1 }, timestampMs: 10 },
      { traceId: "t1", parentTraceId: null, channel: "text", event: "final_answer", data: { answer: "done" }, timestampMs: 20 },
    ];

    const collected: AgentEvent[] = [];
    for await (const ev of wrapper.run(simpleRun(events), "do x", "t1")) {
      collected.push(ev);
    }

    // All events were yielded.
    expect(collected).toHaveLength(events.length);
    // Checkpoint was saved then deleted on final_answer.
    expect(await cp.load("t1")).toBeNull(); // deleted after final_answer
  });

  it("checkpoint is saved and available before final_answer", async () => {
    const cp = new InMemoryCheckpointer();
    const assembler = makeAssembler();
    const wrapper = new CheckpointableRun({ checkpointer: cp }, assembler);

    const events: AgentEvent[] = [
      { traceId: "t2", parentTraceId: null, channel: "text", event: "run_start", data: { task: "task" }, timestampMs: 0 },
      { traceId: "t2", parentTraceId: null, channel: "thinking", event: "step_start", data: { step: 1 }, timestampMs: 10 },
      // Simulate interruption — no final_answer
    ];

    for await (const _ of wrapper.run(simpleRun(events), "task", "t2")) {
      // consume all events
    }

    // After the loop, the checkpoint should be saved (no final_answer to trigger delete).
    const savedSnapshot = await cp.load("t2");
    expect(savedSnapshot).not.toBeNull();
    expect(savedSnapshot?.traceId).toBe("t2");
    expect(savedSnapshot?.stepIndex).toBe(1);
  });

  it("await_human_input event is a valid AgentEvent variant (B4)", () => {
    const ev: AgentEvent = {
      traceId: "t",
      parentTraceId: null,
      channel: "status",
      event: "await_human_input",
      data: { promptId: "p1", prompt: "Confirm?", step: 2 },
      timestampMs: 0,
    };
    expect(ev.event).toBe("await_human_input");
    expect(ev.data.promptId).toBe("p1");
  });
});
