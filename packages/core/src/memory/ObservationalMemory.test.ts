/**
 * A1 — ObservationalMemory tests.
 *
 * Covers the contract documented in ObservationalMemory.ts:
 *   - noteStep is a no-op until the assembler crosses tokenThreshold
 *   - the observer pass runs asynchronously; flush() waits for it
 *   - successful runs persist an observation to KV (when bound) and the cache
 *   - subsequent passes only observe NEW history — coversSteps slides forward
 *   - JSON parsing falls through to "low" priority bare-text on observer drift
 *   - observer errors are captured via getLastError(); main path stays alive
 *   - list() merges KV-backed reads with the in-memory cache
 */

import type { Model, ModelMessage, StreamEvent } from "../models/types.js";
import { MapKvBackend } from "./MemoryTool.js";
import { MessageAssembler } from "./MessageAssembler.js";
import { ObservationalMemory } from "./ObservationalMemory.js";

/** Build a tiny test assembler — system prompt is short so token math is predictable. */
function makeAssembler(): MessageAssembler {
  return new MessageAssembler({ systemPrompt: "sys", toolsSchema: [] });
}

function userStep(content: string): Parameters<MessageAssembler["addStep"]>[0] {
  return { type: "user_message", content };
}

/**
 * Mock observer model that returns a canned reply per call. Tracks calls so
 * tests can assert on them. The reply is yielded as a single text_delta to
 * mimic the streaming contract real adapters use.
 */
function mockObserver(replies: string[]): {
  model: Model;
  calls: { messages: ModelMessage[] }[];
} {
  const calls: { messages: ModelMessage[] }[] = [];
  let i = 0;
  const model: Model = {
    providerId: "mock/observer",
    async *generate(messages: ModelMessage[]): AsyncGenerator<StreamEvent> {
      calls.push({ messages });
      const reply = replies[i] ?? replies[replies.length - 1] ?? "";
      i++;
      yield { type: "text_delta", delta: reply };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
  return { model, calls };
}

let mem: ObservationalMemory | null = null;
afterEach(() => {
  mem?._resetForTests();
  mem = null;
});

describe("ObservationalMemory", () => {
  it("does nothing until the token threshold is crossed", async () => {
    const assembler = makeAssembler();
    assembler.addStep(userStep("hi"));
    const { model, calls } = mockObserver(['{"priority":"low","text":"x"}']);
    mem = new ObservationalMemory({
      assembler,
      model,
      sessionId: "s",
      tokenThreshold: 10_000, // far above the tiny prompt
    });
    mem.noteStep();
    await mem.flush();
    expect(calls.length).toBe(0);
    expect((await mem.list()).length).toBe(0);
  });

  it("triggers an observer pass once the threshold is crossed and persists to KV", async () => {
    const assembler = makeAssembler();
    // Add many user messages to push token estimate above threshold.
    for (let i = 0; i < 12; i++) assembler.addStep(userStep(`msg ${i} ${"x".repeat(200)}`));
    const { model, calls } = mockObserver(['{"priority":"high","text":"discussed several xs"}']);
    const kv = new MapKvBackend();
    mem = new ObservationalMemory({
      assembler,
      model,
      sessionId: "s1",
      tokenThreshold: 100,
      kv,
    });
    mem.noteStep();
    await mem.flush();
    expect(calls.length).toBe(1);
    const obs = await mem.list();
    expect(obs.length).toBe(1);
    expect(obs[0]?.priority).toBe("high");
    expect(obs[0]?.text).toContain("discussed several xs");
    // KV mirror — the same key should be readable directly.
    const keys = await kv.list?.("obs:s1:");
    expect(keys?.length).toBe(1);
  });

  it("subsequent passes only observe NEW history (coversSteps advances)", async () => {
    const assembler = makeAssembler();
    for (let i = 0; i < 12; i++) assembler.addStep(userStep(`A${i} ${"x".repeat(200)}`));
    const { model, calls } = mockObserver([
      '{"priority":"medium","text":"first half"}',
      '{"priority":"medium","text":"second half"}',
    ]);
    mem = new ObservationalMemory({
      assembler,
      model,
      sessionId: "s2",
      tokenThreshold: 100,
      // autoNote:false pins the purely-manual contract here: with the default
      // subscription (#307) passes also fire during step appends, which the
      // auto-note block below covers.
      autoNote: false,
    });
    mem.noteStep();
    await mem.flush();
    const first = await mem.list();
    expect(first.length).toBe(1);
    const firstTo = first[0]?.coversSteps.to ?? 0;

    // Add more steps; threshold remains crossed.
    for (let i = 0; i < 12; i++) assembler.addStep(userStep(`B${i} ${"x".repeat(200)}`));
    mem.noteStep();
    await mem.flush();
    const both = await mem.list();
    expect(both.length).toBe(2);
    expect(calls.length).toBe(2);
    // Second observation must start where the first ended.
    expect(both[1]?.coversSteps.from).toBe(firstTo);
  });

  it("falls through to 'low' priority bare-text when observer ignores the JSON contract", async () => {
    const assembler = makeAssembler();
    for (let i = 0; i < 12; i++) assembler.addStep(userStep(`msg ${"x".repeat(200)}`));
    const { model } = mockObserver(["totally non-json reply with stuff inside"]);
    mem = new ObservationalMemory({
      assembler,
      model,
      sessionId: "s3",
      tokenThreshold: 100,
    });
    mem.noteStep();
    await mem.flush();
    const obs = await mem.list();
    expect(obs.length).toBe(1);
    expect(obs[0]?.priority).toBe("low");
    expect(obs[0]?.text).toContain("non-json reply");
  });

  it("captures observer error in getLastError without throwing from noteStep", async () => {
    const assembler = makeAssembler();
    for (let i = 0; i < 12; i++) assembler.addStep(userStep(`msg ${"x".repeat(200)}`));
    const failingModel: Model = {
      providerId: "mock/fail",
      async *generate(): AsyncGenerator<StreamEvent> {
        // This generator intentionally throws before yielding to simulate an
        // observer outage; the unreachable yield below satisfies lint while
        // keeping the throw-first behaviour the test relies on.
        if (false as boolean) yield { type: "text_delta", delta: "" } as StreamEvent;
        throw new Error("simulated observer outage");
      },
    };
    mem = new ObservationalMemory({
      assembler,
      model: failingModel,
      sessionId: "s4",
      tokenThreshold: 100,
    });
    // Should not throw synchronously…
    expect(() => mem?.noteStep()).not.toThrow();
    // …or asynchronously.
    await mem.flush();
    expect(mem.getLastError()).toMatch(/simulated observer outage/);
    expect((await mem.list()).length).toBe(0);
  });

  it("uses the observerModel override when one is provided", async () => {
    const assembler = makeAssembler();
    for (let i = 0; i < 12; i++) assembler.addStep(userStep(`msg ${"x".repeat(200)}`));
    const main = mockObserver(['{"priority":"low","text":"main"}']);
    const obs = mockObserver(['{"priority":"high","text":"OBSERVED-BY-CHEAP-MODEL"}']);
    mem = new ObservationalMemory({
      assembler,
      model: main.model,
      observerModel: obs.model,
      sessionId: "s5",
      tokenThreshold: 100,
    });
    mem.noteStep();
    await mem.flush();
    expect(main.calls.length).toBe(0);
    expect(obs.calls.length).toBe(1);
    const list = await mem.list();
    expect(list[0]?.text).toContain("OBSERVED-BY-CHEAP-MODEL");
  });

  it("noteStep is a no-op while a previous pass is still running", async () => {
    const assembler = makeAssembler();
    for (let i = 0; i < 12; i++) assembler.addStep(userStep(`msg ${"x".repeat(200)}`));
    let resolveSlow!: () => void;
    const slowModel: Model = {
      providerId: "mock/slow",
      async *generate(): AsyncGenerator<StreamEvent> {
        await new Promise<void>((r) => {
          resolveSlow = r;
        });
        yield { type: "text_delta", delta: '{"priority":"low","text":"slow"}' };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    mem = new ObservationalMemory({
      assembler,
      model: slowModel,
      sessionId: "s6",
      tokenThreshold: 100,
    });
    mem.noteStep(); // schedules the slow pass
    mem.noteStep(); // should be buffered while pending
    mem.noteStep(); // ditto
    resolveSlow();
    await mem.flush();
    // Only one observation should land (buffered calls collapse into one drain).
    expect((await mem.list()).length).toBe(1);
  });

  it("buffers noteStep calls during background pass and processes them after completion", async () => {
    const assembler = makeAssembler();
    for (let i = 0; i < 12; i++) assembler.addStep(userStep(`msg ${"x".repeat(200)}`));
    let resolvePass!: () => void;
    let callCount = 0;
    const slowModel: Model = {
      providerId: "mock/slow2",
      async *generate(): AsyncGenerator<StreamEvent> {
        callCount++;
        if (callCount === 1) {
          await new Promise<void>((r) => {
            resolvePass = r;
          });
        }
        yield { type: "text_delta", delta: `{"priority":"medium","text":"obs ${callCount}"}` };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    mem = new ObservationalMemory({
      assembler,
      model: slowModel,
      sessionId: "s7",
      tokenThreshold: 100,
    });
    mem.noteStep(); // triggers first pass (slow)
    // Add more steps while pass is in flight
    for (let i = 0; i < 12; i++) assembler.addStep(userStep(`msg2 ${"y".repeat(200)}`));
    mem.noteStep(); // should be buffered, not dropped
    // Complete the first pass
    resolvePass();
    await mem.flush();
    // Both the first pass and the buffered drain pass should have run
    expect(callCount).toBe(2);
    const obs = await mem.list();
    expect(obs.length).toBe(2);
  });
});

// ── Auto-note wiring (#307) ─────────────────────────────────────────────────
//
// autoNote defaults to true: the memory subscribes to assembler appends and
// fires noteStep() on its own, so agent loops can't silently forget it and
// let sessions grow unbounded.

describe("ObservationalMemory auto-note wiring (#307)", () => {
  afterEach(() => {
    mem?.dispose();
  });

  it("fires noteStep automatically when the assembler gains steps", async () => {
    const assembler = makeAssembler();
    const { model, calls } = mockObserver(['{"priority":"low","text":"auto"}']);
    // Constructed BEFORE any step is added — the hook must still see appends.
    mem = new ObservationalMemory({
      assembler,
      model,
      sessionId: "s-auto",
      tokenThreshold: 100,
    });
    for (let i = 0; i < 12; i++) assembler.addStep(userStep(`msg ${i} ${"x".repeat(200)}`));
    await mem.flush(); // no manual noteStep() anywhere in this test
    expect(calls.length).toBeGreaterThan(0);
    expect((await mem.list()).length).toBe(calls.length);
  });

  it("autoNote: false keeps purely manual control", async () => {
    const assembler = makeAssembler();
    const { model, calls } = mockObserver(['{"priority":"low","text":"manual"}']);
    mem = new ObservationalMemory({
      assembler,
      model,
      sessionId: "s-manual",
      tokenThreshold: 100,
      autoNote: false,
    });
    for (let i = 0; i < 12; i++) assembler.addStep(userStep(`msg ${i} ${"x".repeat(200)}`));
    await mem.flush();
    expect(calls.length).toBe(0);
    mem.noteStep();
    await mem.flush();
    expect(calls.length).toBe(1);
  });

  it("dispose() detaches the hook but explicit noteStep() still works", async () => {
    const assembler = makeAssembler();
    const { model, calls } = mockObserver(['{"priority":"low","text":"d"}']);
    mem = new ObservationalMemory({
      assembler,
      model,
      sessionId: "s-dispose",
      tokenThreshold: 100,
    });
    // Cross the threshold once so we know the hook was live.
    for (let i = 0; i < 6; i++) assembler.addStep(userStep(`msg ${i} ${"x".repeat(200)}`));
    await mem.flush();
    expect(calls.length).toBeGreaterThan(0);

    mem.dispose();
    const detachedAt = calls.length;
    for (let i = 0; i < 6; i++) assembler.addStep(userStep(`msg2 ${i} ${"y".repeat(200)}`));
    await mem.flush();
    expect(calls.length).toBe(detachedAt); // subscription detached — no auto fire

    mem.noteStep();
    await mem.flush();
    expect(calls.length).toBe(detachedAt + 1); // manual path unaffected
    mem.dispose(); // idempotent
  });
});
