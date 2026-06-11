/**
 * A2 — EventLog tests. Covers:
 *  - Live tap assigns monotonic ids and persists each event
 *  - replay() with no Last-Event-ID returns the full log in order
 *  - replay() with Last-Event-ID skips already-delivered events (no gap, no dup)
 *  - highWaterMark / nextSeq enable resuming a partially-completed run
 *  - purge clears the trace; cross-trace isolation holds
 *  - SSE frame formatting includes the id: line
 */

import { describe, expect, it } from "vitest";
import { MapKvBackend } from "../memory/MemoryTool.js";
import type { AgentEvent } from "../types/events.js";
import { EventLog, formatSseFrame } from "./EventLog.js";

function ev(step: number): AgentEvent {
  return {
    traceId: "t",
    parentTraceId: null,
    timestampMs: 1000 + step,
    channel: "thinking",
    event: "step_start",
    data: { step },
  };
}

async function* generate(steps: number): AsyncGenerator<AgentEvent> {
  for (let i = 0; i < steps; i++) yield ev(i);
}

describe("EventLog", () => {
  it("tap assigns monotonic ids and persists each event", async () => {
    const kv = new MapKvBackend();
    const log = new EventLog(kv);

    const out: string[] = [];
    for await (const { eventId } of log.tap(generate(5), "trace-1")) {
      out.push(eventId);
    }

    // ids must be lexicographic-sorted == numeric-sorted (fixed-width padding).
    expect(out).toEqual([...out].sort());
    expect(out.length).toBe(5);
    expect(new Set(out).size).toBe(5); // unique

    // KV got 5 entries under the trace prefix.
    expect((await kv.list("evlog:trace-1:")).length).toBe(5);
  });

  it("replay returns the full log when Last-Event-ID is absent", async () => {
    const kv = new MapKvBackend();
    const log = new EventLog(kv);
    for await (const _ of log.tap(generate(3), "t")) {
      /* drain */
    }

    const replayed = [];
    for await (const r of log.replay("t")) replayed.push(r.event.data);
    expect(replayed.length).toBe(3);
    expect(replayed[0]).toMatchObject({ step: 0 });
    expect(replayed[2]).toMatchObject({ step: 2 });
  });

  it("replay with Last-Event-ID skips delivered events with no gap and no duplicate", async () => {
    const kv = new MapKvBackend();
    const log = new EventLog(kv);

    const ids: string[] = [];
    for await (const r of log.tap(generate(10), "t")) ids.push(r.eventId);

    // Pretend client received up to id index 4 (inclusive).
    const lastSeen = ids[4];
    const replayed = [];
    for await (const r of log.replay("t", lastSeen)) replayed.push(r.eventId);

    // Must yield ids 5..9 — exactly the missing tail.
    expect(replayed).toEqual(ids.slice(5));
  });

  it("Last-Event-ID strictly greater than all stored ids yields nothing", async () => {
    const kv = new MapKvBackend();
    const log = new EventLog(kv);
    for await (const _ of log.tap(generate(3), "t")) {
      /* drain */
    }
    const replayed = [];
    for await (const r of log.replay("t", "999999999999")) replayed.push(r);
    expect(replayed).toEqual([]);
  });

  it("malformed Last-Event-ID is treated as 'deliver everything'", async () => {
    const kv = new MapKvBackend();
    const log = new EventLog(kv);
    for await (const _ of log.tap(generate(2), "t")) {
      /* drain */
    }
    const replayed = [];
    for await (const r of log.replay("t", "not-a-number")) replayed.push(r);
    expect(replayed.length).toBe(2);
  });

  it("highWaterMark / nextSeq let a fresh process continue numbering", async () => {
    const kv = new MapKvBackend();
    const log = new EventLog(kv);
    for await (const _ of log.tap(generate(3), "t")) {
      /* drain */
    }

    expect(await log.highWaterMark("t")).toBe("000000000002");
    expect(await log.nextSeq("t")).toBe(3);

    // New tap continues numbering (no collisions).
    const ids: string[] = [];
    for await (const r of log.tap(generate(2), "t", { startSeq: await log.nextSeq("t") })) {
      ids.push(r.eventId);
    }
    expect(ids).toEqual(["000000000003", "000000000004"]);
  });

  it("purge clears only the targeted trace", async () => {
    const kv = new MapKvBackend();
    const log = new EventLog(kv);
    for await (const _ of log.tap(generate(2), "trace-A")) {
      /* drain */
    }
    for await (const _ of log.tap(generate(3), "trace-B")) {
      /* drain */
    }

    await log.purge("trace-A");

    expect((await kv.list("evlog:trace-A:")).length).toBe(0);
    expect((await kv.list("evlog:trace-B:")).length).toBe(3);
  });

  it("the kill-and-replay round trip is gap- and duplicate-free", async () => {
    // Simulates: server taps 6 events, dies; client reconnects with Last-Event-ID
    // = id of the 4th event; server replays, then live-taps 3 more.
    const kv = new MapKvBackend();
    const log = new EventLog(kv);

    const initial: string[] = [];
    for await (const r of log.tap(generate(6), "trace-resume")) initial.push(r.eventId);
    const lastSeen = initial[3];

    // Resume = replay + continue.
    const seen: string[] = [];
    for await (const r of log.replay("trace-resume", lastSeen)) seen.push(r.eventId);
    const startSeq = await log.nextSeq("trace-resume");
    for await (const r of log.tap(generate(3), "trace-resume", { startSeq })) {
      seen.push(r.eventId);
    }

    // Combined sequence (already-seen) + (newly delivered) must be id 4..8 monotonically.
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen[0]).toBe(initial[4]); // first replayed event is index 4
  });

  it("rejects KvBackend without list()", () => {
    const noList = { get: async () => null, put: async () => {}, delete: async () => {} };
    expect(() => new EventLog(noList)).toThrow(/list/);
  });
});

describe("formatSseFrame", () => {
  it("produces a frame with id, event, and data lines and a blank-line terminator", () => {
    const frame = formatSseFrame({ eventId: "000000000007", event: ev(7) });
    expect(frame.startsWith("id: 000000000007\n")).toBe(true);
    expect(frame).toContain("event: step_start\n");
    expect(frame).toContain('"step":7');
    expect(frame.endsWith("\n\n")).toBe(true);
  });
});
