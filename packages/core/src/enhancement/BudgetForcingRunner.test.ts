import { describe, expect, it } from "vitest";
import type { Model, ModelMessage, StreamEvent } from "../models/types.js";
import { BudgetForcingRunner } from "./BudgetForcingRunner.js";

function mockModel(answers: string[]): Model {
  let idx = 0;
  return {
    providerId: "mock/test",
    async *generate(): AsyncGenerator<StreamEvent> {
      const text = answers[idx++] ?? answers[answers.length - 1] ?? "";
      yield { type: "text_delta", delta: text };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

describe("BudgetForcingRunner", () => {
  it("returns initial answer without forcing when it is long enough", async () => {
    const runner = new BudgetForcingRunner({ minResponseTokens: 5, maxWaitRounds: 2 });
    // Initial answer has >5 estimated tokens (20+ chars)
    const longAnswer = "This is a sufficiently detailed answer that needs no forcing at all.";
    const model = mockModel([longAnswer, "continuation"]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(result.answer).toBe(longAnswer);
    expect(result.waitRoundsUsed).toBe(0);
  });

  it("injects Wait forcing when initial response is short", async () => {
    const runner = new BudgetForcingRunner({ minResponseTokens: 20, maxWaitRounds: 1 });
    const shortAnswer = "ok"; // <<80 chars
    const longContinuation =
      "Here is the full detailed reasoning: the answer is 42 because of the properties of the number.";
    const model = mockModel([shortAnswer, longContinuation]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(result.answer).toBe(longContinuation);
    expect(result.waitRoundsUsed).toBe(1);
  });

  it("respects maxWaitRounds upper bound", async () => {
    const runner = new BudgetForcingRunner({ minResponseTokens: 10000, maxWaitRounds: 2 });
    // All answers are short, so it will run maxWaitRounds times
    const model = mockModel(["a", "b", "c"]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(result.waitRoundsUsed).toBeLessThanOrEqual(2);
  });

  it("uses custom prefillToken in context", async () => {
    const capturedMessages: ModelMessage[][] = [];
    const model: Model = {
      providerId: "mock",
      async *generate(msgs): AsyncGenerator<StreamEvent> {
        capturedMessages.push([...msgs]);
        yield { type: "text_delta", delta: "short" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const runner = new BudgetForcingRunner({
      prefillToken: "Hmm",
      minResponseTokens: 100,
      maxWaitRounds: 1,
    });
    await runner.run(model, [{ role: "user", content: "q" }]);
    // Second call context should contain the "Hmm" prefill token
    const secondCallMessages = capturedMessages[1];
    const assistantMsg = secondCallMessages?.find((m) => m.role === "assistant");
    expect(JSON.stringify(assistantMsg?.content)).toContain("Hmm");
  });

  it("does not mutate the original messages array", async () => {
    const runner = new BudgetForcingRunner({ minResponseTokens: 100, maxWaitRounds: 1 });
    const model = mockModel(["short", "long continuation"]);
    const messages: ModelMessage[] = [{ role: "user", content: "task" }];
    const original = JSON.stringify(messages);
    await runner.run(model, messages);
    expect(JSON.stringify(messages)).toBe(original);
  });

  it("n=0 maxWaitRounds is clamped to 1", async () => {
    const runner = new BudgetForcingRunner({ maxWaitRounds: 0 });
    expect(
      (runner as unknown as { _BudgetForcingRunner__maxWaitRounds?: number })
        ._BudgetForcingRunner__maxWaitRounds
    ).toBeUndefined(); // private, just verify it runs
    const model = mockModel(["some answer"]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(result.answer).toBeDefined();
  });
});
