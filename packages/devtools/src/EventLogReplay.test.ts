/**
 * A2 — EventLogReplay tests.
 *
 * Covers the engine's contract:
 *   - step boundaries are derived from `step_start` events
 *   - select(N) returns the prefix up to AND INCLUDING step N
 *   - forkAt produces a prefix + a meta bundle the caller can resume from
 *   - stepForEventId maps event → step
 *   - finalAnswer is surfaced when present in the prefix
 */

import type { AgentEvent } from "@wasmagent/core";
import { EventLogReplay, type LoggedEvent } from "./EventLogReplay.js";

let seq = 0;
function logged(event: { event: string; data?: Record<string, unknown> }): LoggedEvent {
  seq += 1;
  return {
    eventId: String(seq).padStart(6, "0"),
    event: {
      traceId: "t",
      parentTraceId: null,
      channel: "text",
      timestampMs: 0,
      data: {},
      ...event,
    } as unknown as AgentEvent,
  };
}

function makeTrace(): LoggedEvent[] {
  seq = 0;
  return [
    logged({ event: "run_start" }),
    logged({ event: "step_start", data: { step: 1 } }),
    logged({ event: "tool_call_start", data: { toolName: "read_file" } }),
    logged({ event: "tool_call_end", data: { toolName: "read_file" } }),
    logged({ event: "step_start", data: { step: 2 } }),
    logged({ event: "model_done", data: { inputTokens: 10 } }),
    logged({ event: "step_start", data: { step: 3 } }),
    logged({ event: "final_answer", data: { answer: "42" } }),
  ];
}

describe("EventLogReplay", () => {
  it("computes step boundaries from step_start events", () => {
    const r = new EventLogReplay(makeTrace());
    expect(r.eventCount).toBe(8);
    expect(r.stepCount).toBe(3);
    expect(r.steps[0]?.events.length).toBe(3); // step_start, tool_start, tool_end
    expect(r.steps[1]?.events.length).toBe(2); // step_start, model_done
    expect(r.steps[2]?.events.length).toBe(2); // step_start, final_answer
  });

  it("select(0) returns events before the first step_start", () => {
    const r = new EventLogReplay(makeTrace());
    const cur = r.select(0);
    expect(cur.currentStep).toBe(0);
    expect(cur.prefixEvents.length).toBe(1);
    expect(cur.prefixEvents[0]?.event.event).toBe("run_start");
    expect(cur.finalAnswer).toBeNull();
  });

  it("select(2) returns events through the end of step 2", () => {
    const r = new EventLogReplay(makeTrace());
    const cur = r.select(2);
    expect(cur.currentStep).toBe(2);
    // run_start + step1's 3 + step2's 2 = 6
    expect(cur.prefixEvents.length).toBe(6);
    expect(cur.finalAnswer).toBeNull();
  });

  it("select(3) reaches the final answer", () => {
    const r = new EventLogReplay(makeTrace());
    const cur = r.select(3);
    expect(cur.currentStep).toBe(3);
    expect(cur.prefixEvents.length).toBe(8);
    expect(cur.finalAnswer).toBe("42");
  });

  it("select clamps out-of-range indices", () => {
    const r = new EventLogReplay(makeTrace());
    expect(r.select(-5).currentStep).toBe(0);
    expect(r.select(99).currentStep).toBe(3);
  });

  it("forkAt returns the prefix + meta with a fork point", () => {
    const r = new EventLogReplay(makeTrace(), { traceId: "abc" });
    const fork = r.forkAt(2, {
      task: "redo step 3 with claude-haiku",
      modelId: "claude-haiku-4-5",
    });
    expect(fork.forkedAtStep).toBe(2);
    expect(fork.prefixEvents.length).toBe(6);
    expect(fork.meta.task).toContain("redo step 3");
    expect(fork.meta.modelId).toBe("claude-haiku-4-5");
    expect(fork.meta.forkedFromTraceId).toBe("abc");
  });

  it("stepForEventId maps an arbitrary event id back to its containing step", () => {
    const r = new EventLogReplay(makeTrace());
    // Event id 000004 is the tool_call_end inside step 1.
    expect(r.stepForEventId("000004")).toBe(1);
    // Event id 000007 is step 3's step_start.
    expect(r.stepForEventId("000007")).toBe(3);
    // Event id 000001 precedes the first step_start → 0.
    expect(r.stepForEventId("000001")).toBe(0);
  });

  it("handles a trace with zero step_start events", () => {
    seq = 0;
    const events: LoggedEvent[] = [logged({ event: "run_start" }), logged({ event: "model_done" })];
    const r = new EventLogReplay(events);
    expect(r.stepCount).toBe(0);
    const cur = r.select(0);
    // With no steps, select(0) returns the full log.
    expect(cur.prefixEvents.length).toBe(2);
  });

  it("constructor takes a defensive copy — external mutation is ignored", () => {
    const events = makeTrace();
    const r = new EventLogReplay(events);
    // Mutate the source array; the engine's view should be unaffected.
    events.length = 0;
    expect(r.eventCount).toBe(8);
  });
});
