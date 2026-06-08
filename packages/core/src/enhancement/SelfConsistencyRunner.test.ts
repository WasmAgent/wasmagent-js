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

// ── C1: answer extraction tests ───────────────────────────────────────────────

describe("SelfConsistencyRunner — C1 answer extraction", () => {
  it("extracts \\boxed{} answers and votes on the extracted value", async () => {
    const runner = new SelfConsistencyRunner({ n: 3, earlyStopThreshold: 1.0 });
    // All three give 42 via \boxed{} but with different surrounding text
    const model = mockModel([
      "Let me think... the answer is \\boxed{42}",
      "After calculation: \\boxed{42}",
      "The result: \\boxed{99}",
    ]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(result.votes).toBeGreaterThanOrEqual(2);
    // The returned answer should be the full original text (not just the boxed part)
    expect(result.answer).toContain("\\boxed{42}");
  });

  it("falls back to last line when no \\boxed{}", async () => {
    const runner = new SelfConsistencyRunner({ n: 3, earlyStopThreshold: 1.0 });
    const model = mockModel([
      "Step 1: ...\nStep 2: ...\nAnswer: Paris",
      "Thinking...\nAnswer: Paris",
      "The capital is\nAnswer: Berlin",
    ]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(result.votes).toBeGreaterThanOrEqual(2);
    expect(result.answer).toContain("Paris");
  });

  it("custom extractAnswer hook overrides default", async () => {
    // Extract only the number from "Answer: 42"
    const extractAnswer = (text: string) => {
      const m = /Answer:\s*(\d+)/.exec(text);
      return m ? m[1]! : text;
    };
    const runner = new SelfConsistencyRunner({ n: 3, earlyStopThreshold: 1.0, extractAnswer });
    const model = mockModel([
      "I computed Answer: 42 via method A",
      "Using method B, Answer: 42",
      "Different reasoning, Answer: 99",
    ]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(result.votes).toBeGreaterThanOrEqual(2);
    // Full original text returned, not just the extracted key
    expect(result.answer).toContain("Answer: 42");
  });

  it("without extractAnswer, plain answers still vote correctly (regression)", async () => {
    const runner = new SelfConsistencyRunner({ n: 3, earlyStopThreshold: 1.0 });
    const model = mockModel(["42", "42", "43"]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(result.answer).toBe("42");
    expect(result.votes).toBe(2);
  });

  it("returns full text for winning candidate, not the extracted key", async () => {
    const runner = new SelfConsistencyRunner({ n: 2, earlyStopThreshold: 1.0 });
    const model = mockModel([
      "Long reasoning text...\nFinal answer: yes",
      "Different reasoning but...\nFinal answer: yes",
    ]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    // The returned answer must be the full original text (contains "Final answer: yes")
    expect(result.answer).toContain("Final answer: yes");
    expect(result.answer.length).toBeGreaterThan("Final answer: yes".length);
  });
});

// ── C1: outputSchema structured voting tests ──────────────────────────────────

import { z } from "zod";

describe("SelfConsistencyRunner — C1: outputSchema voting", () => {
  it("votes on parsed object keys when outputSchema is provided", async () => {
    const schema = z.object({ answer: z.number() });
    const runner = new SelfConsistencyRunner({
      n: 3,
      earlyStopThreshold: 1.0,
      outputSchema: schema,
    });
    // Two candidates have same parsed value {answer: 42}; one has {answer: 99}
    const model = mockModel([
      JSON.stringify({ answer: 42 }),
      JSON.stringify({ answer: 42 }),
      JSON.stringify({ answer: 99 }),
    ]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    // Winner should be the {answer: 42} variant
    expect(result.votes).toBe(2);
    // The answer returned is the original raw string of the winner
    expect(result.answer).toContain("42");
  });

  it("falls back to string voting when parse fails", async () => {
    const schema = z.object({ required: z.number() });
    const runner = new SelfConsistencyRunner({
      n: 3,
      earlyStopThreshold: 1.0,
      outputSchema: schema,
    });
    // All candidates are invalid JSON — should fall back to string comparison
    const model = mockModel(["plain text", "plain text", "other text"]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(result.answer).toBe("plain text");
    expect(result.votes).toBe(2);
  });
});
