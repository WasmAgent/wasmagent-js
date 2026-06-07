import { describe, it, expect, vi } from "vitest";
import { ReflectRefineRunner } from "./ReflectRefineRunner.js";
import type { Model, ModelMessage, StreamEvent } from "../models/types.js";

/** Model that returns pre-defined answers per call index. */
function sequentialModel(answers: string[]): Model {
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

describe("ReflectRefineRunner", () => {
  it("runs exactly one cycle by default", async () => {
    const runner = new ReflectRefineRunner();
    // call 0: initial draft, call 1: critique, call 2: refined answer
    const model = sequentialModel(["draft answer", "some critique", "refined answer"]);
    const result = await runner.run(model, [{ role: "user", content: "task" }]);
    expect(result.answer).toBe("refined answer");
    expect(result.cyclesUsed).toBe(1);
  });

  it("stops early when qualitySignal returns true on draft", async () => {
    const runner = new ReflectRefineRunner({
      maxCycles: 3,
      qualitySignal: (draft) => draft.includes("final"),
    });
    const model = sequentialModel(["this is final", "critique", "refined"]);
    const result = await runner.run(model, [{ role: "user", content: "task" }]);
    expect(result.answer).toBe("this is final");
    expect(result.cyclesUsed).toBe(0);
  });

  it("runs up to maxCycles when qualitySignal always returns false", async () => {
    const runner = new ReflectRefineRunner({
      maxCycles: 2,
      qualitySignal: () => false,
    });
    // 1 initial + 2*(critique+refine) = 5 calls
    const model = sequentialModel(["d0", "c1", "r1", "c2", "r2"]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(result.answer).toBe("r2");
    expect(result.cyclesUsed).toBe(2);
  });

  it("does not mutate the original messages array", async () => {
    const runner = new ReflectRefineRunner({ maxCycles: 1 });
    const model = sequentialModel(["draft", "critique", "refined"]);
    const messages: ModelMessage[] = [{ role: "user", content: "task" }];
    const original = JSON.stringify(messages);
    await runner.run(model, messages);
    expect(JSON.stringify(messages)).toBe(original);
  });

  it("includes critique context in refine call messages", async () => {
    const capturedMessages: ModelMessage[][] = [];
    const model: Model = {
      providerId: "mock",
      async *generate(msgs): AsyncGenerator<StreamEvent> {
        capturedMessages.push([...msgs]);
        yield { type: "text_delta", delta: `resp-${capturedMessages.length}` };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const runner = new ReflectRefineRunner({ maxCycles: 1 });
    await runner.run(model, [{ role: "user", content: "original" }]);
    // Refine call (3rd) should have the draft and critique in context.
    const refineMessages = capturedMessages[2];
    expect(refineMessages?.length).toBeGreaterThan(1);
    // The second-to-last user message is the critique prompt.
    const userMessages = refineMessages?.filter((m) => m.role === "user") ?? [];
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
  });

  it("supports async qualitySignal", async () => {
    const runner = new ReflectRefineRunner({
      maxCycles: 3,
      qualitySignal: async (draft) => {
        await Promise.resolve();
        return draft.startsWith("ok");
      },
    });
    const model = sequentialModel(["bad", "c1", "ok answer", "c2", "r2"]);
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(result.answer).toBe("ok answer");
    expect(result.cyclesUsed).toBe(1);
  });

  it("forwards generateOpts to all model calls", async () => {
    const temps: number[] = [];
    const model: Model = {
      providerId: "mock",
      async *generate(_msgs, opts): AsyncGenerator<StreamEvent> {
        if (opts?.temperature !== undefined) temps.push(opts.temperature);
        yield { type: "text_delta", delta: "ans" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const runner = new ReflectRefineRunner({ maxCycles: 1 });
    await runner.run(model, [{ role: "user", content: "q" }], { temperature: 0.3 });
    // All 3 calls (initial, critique, refine) should get temperature=0.3
    expect(temps.every((t) => t === 0.3)).toBe(true);
    expect(temps.length).toBe(3);
  });
});
