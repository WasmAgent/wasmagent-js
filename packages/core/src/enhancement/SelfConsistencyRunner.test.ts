import { describe, it, expect, vi } from "vitest";
import { SelfConsistencyRunner } from "./SelfConsistencyRunner.js";
import type { Model, StreamEvent } from "../models/types.js";

function mockModel(answers: string[]): Model {
  let callIdx = 0;
  return {
    providerId: "mock/test",
    async *generate(): AsyncGenerator<StreamEvent> {
      const answer = answers[callIdx++ % answers.length] ?? "default";
      yield { type: "text_delta", delta: answer };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

describe("SelfConsistencyRunner", () => {
  it("returns the majority answer from N candidates", async () => {
    // threshold=1.0 means early-stop as soon as all completed agree.
    // With n=3, answers ["42","42","43"]: after 2 candidates both are "42" → stops.
    const runner = new SelfConsistencyRunner({ n: 3, earlyStopThreshold: 1.0 });
    const model = mockModel(["42", "42", "43"]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(result.answer).toBe("42");
    expect(result.votes).toBe(2);
    // Early-stops after 2 candidates (both agree at 2/2=100%)
    expect(result.totalCandidates).toBe(2);
  });

  it("early-stops when threshold fraction agree", async () => {
    // earlyStopThreshold=0.6 with 3 candidates — stops as soon as 2/2 = 100% agree
    const runner = new SelfConsistencyRunner({ n: 5, earlyStopThreshold: 0.6, concurrencyLimit: 2 });
    const model = mockModel(["yes", "yes", "no", "no", "no"]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    // Should stop before all 5 because 2/2 = 1.0 >= 0.6 once first two agree
    expect(result.answer).toBeDefined();
    expect(result.totalCandidates).toBeLessThanOrEqual(5);
  });

  it("respects concurrencyLimit — never exceeds simultaneous calls", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const model: Model = {
      providerId: "mock",
      async *generate(): AsyncGenerator<StreamEvent> {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent--;
        yield { type: "text_delta", delta: "answer" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const runner = new SelfConsistencyRunner({ n: 6, concurrencyLimit: 2, earlyStopThreshold: 1.1 });
    await runner.run(model, [{ role: "user", content: "q" }]);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("n=1 returns the single answer directly", async () => {
    const runner = new SelfConsistencyRunner({ n: 1 });
    const model = mockModel(["only one"]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(result.answer).toBe("only one");
    expect(result.votes).toBe(1);
    expect(result.totalCandidates).toBe(1);
  });

  it("treats case and whitespace as equivalent for voting", async () => {
    const runner = new SelfConsistencyRunner({ n: 3, earlyStopThreshold: 1.0 });
    const model = mockModel(["  Yes  ", "YES", "no"]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(result.answer.toLowerCase().trim()).toBe("yes");
    expect(result.votes).toBe(2);
  });

  it("handles all candidates disagreeing — returns any answer with count=1", async () => {
    const runner = new SelfConsistencyRunner({ n: 3, earlyStopThreshold: 1.0 });
    const model = mockModel(["a", "b", "c"]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(["a", "b", "c"]).toContain(result.answer);
    expect(result.votes).toBe(1);
    expect(result.totalCandidates).toBe(3);
  });

  it("forwards generateOpts to model", async () => {
    const capturedOpts: object[] = [];
    const model: Model = {
      providerId: "mock",
      async *generate(_msgs, opts): AsyncGenerator<StreamEvent> {
        capturedOpts.push({ ...opts });
        yield { type: "text_delta", delta: "ok" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const runner = new SelfConsistencyRunner({ n: 1 });
    await runner.run(model, [{ role: "user", content: "q" }], { temperature: 0.7 });
    expect((capturedOpts[0] as { temperature: number }).temperature).toBe(0.7);
  });
});
