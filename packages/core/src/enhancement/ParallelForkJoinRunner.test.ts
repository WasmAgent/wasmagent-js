import { describe, it, expect, vi } from "vitest";
import { ParallelForkJoinRunner } from "./ParallelForkJoinRunner.js";
import type { Model, ModelMessage, StreamEvent } from "../models/types.js";

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

const Q: ModelMessage[] = [{ role: "user", content: "What is 2+2?" }];

describe("ParallelForkJoinRunner", () => {
  it("default: runs 3 branches then returns aggregated summary", async () => {
    // Branches return A/B/C, summary call returns "synthesised"
    const model = mockModel(["A", "B", "C", "synthesised"]);
    const runner = new ParallelForkJoinRunner({ branches: 3 });
    const result = await runner.run(model, Q);
    expect(result.branches).toHaveLength(3);
    expect(result.branchesCompleted).toBe(3);
    expect(result.answer).toBe("synthesised");
  });

  it("aggregation=first: returns first completed branch", async () => {
    const model = mockModel(["branchAnswer"]);
    const runner = new ParallelForkJoinRunner({ branches: 3, aggregation: "first" });
    const result = await runner.run(model, Q);
    expect(result.answer).toBe("branchAnswer");
    expect(result.branchesCompleted).toBe(1);
  });

  it("aggregation=fn: uses custom aggregator over all branches", async () => {
    const model = mockModel(["X", "Y", "Z"]);
    const aggregation = vi.fn((results: string[]) => results.join("+"));
    const runner = new ParallelForkJoinRunner({ branches: 3, aggregation });
    const result = await runner.run(model, Q);
    expect(aggregation).toHaveBeenCalledWith(["X", "Y", "Z"]);
    expect(result.answer).toBe("X+Y+Z");
  });

  it("branchPrompt injects branch-specific context", async () => {
    const capturedMessages: ModelMessage[][] = [];
    const model: Model = {
      providerId: "mock",
      async *generate(msgs): AsyncGenerator<StreamEvent> {
        capturedMessages.push(msgs);
        yield { type: "text_delta", delta: "ok" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const branchPrompt = (i: number, base: ModelMessage[]): ModelMessage[] => [
      ...base,
      { role: "user", content: `Perspective ${i}` },
    ];
    const runner = new ParallelForkJoinRunner({ branches: 2, aggregation: (r) => r[0]!, branchPrompt });
    await runner.run(model, Q);
    // First 2 calls are branches (3rd would be summary, but fn aggregation skips it)
    expect(capturedMessages[0]?.at(-1)?.content).toBe("Perspective 0");
    expect(capturedMessages[1]?.at(-1)?.content).toBe("Perspective 1");
  });

  it("original messages array is not mutated", async () => {
    const model = mockModel(["a", "b", "summary"]);
    const original = [{ role: "user" as const, content: "q" }];
    const frozen = JSON.stringify(original);
    const runner = new ParallelForkJoinRunner({ branches: 2 });
    await runner.run(model, original);
    expect(JSON.stringify(original)).toBe(frozen);
  });

  it("respects concurrency cap — never exceeds simultaneous branch calls", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const model: Model = {
      providerId: "mock",
      async *generate(): AsyncGenerator<StreamEvent> {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent--;
        yield { type: "text_delta", delta: "ans" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    // branches=4, concurrency=2 — summary call is sequential so won't overlap branches
    const runner = new ParallelForkJoinRunner({ branches: 4, concurrency: 2, aggregation: (r) => r[0]! });
    await runner.run(model, Q);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("drops failed branches and continues with successful ones", async () => {
    let callCount = 0;
    const model: Model = {
      providerId: "mock",
      async *generate(): AsyncGenerator<StreamEvent> {
        const idx = callCount++;
        if (idx === 1) throw new Error("branch 1 failed");
        yield { type: "text_delta", delta: `branch${idx}` };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const runner = new ParallelForkJoinRunner({ branches: 3, aggregation: (r) => r.join(",") });
    const result = await runner.run(model, Q);
    // branch 1 (idx=1) failed, branches 0 and 2 succeed
    expect(result.branchesCompleted).toBe(2);
    expect(result.answer).toContain("branch0");
  });

  it("branches=1 skips aggregation and returns single branch answer", async () => {
    const model = mockModel(["only"]);
    const runner = new ParallelForkJoinRunner({ branches: 1 });
    const result = await runner.run(model, Q);
    expect(result.answer).toBe("only");
    expect(result.branchesCompleted).toBe(1);
    expect(result.branches).toHaveLength(1);
  });

  it("forwards generateOpts to branch calls", async () => {
    const capturedOpts: object[] = [];
    const model: Model = {
      providerId: "mock",
      async *generate(_msgs, opts): AsyncGenerator<StreamEvent> {
        capturedOpts.push({ ...opts });
        yield { type: "text_delta", delta: "ok" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const runner = new ParallelForkJoinRunner({ branches: 1, aggregation: (r) => r[0]! });
    await runner.run(model, Q, { temperature: 0.5 });
    expect((capturedOpts[0] as { temperature: number }).temperature).toBe(0.5);
  });
});
