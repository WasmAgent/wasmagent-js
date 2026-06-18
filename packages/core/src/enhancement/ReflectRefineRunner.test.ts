import type { Model, ModelMessage, StreamEvent } from "../models/types.js";
import { ReflectRefineRunner } from "./ReflectRefineRunner.js";

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

// ── C1: output guardrails as quality signal ───────────────────────────────────

import { forbiddenPhrases, type OutputGuardrail } from "../guardrails/index.js";

describe("ReflectRefineRunner — C1: outputGuardrails as quality signal", () => {
  it("stops early when no output guardrail tripwire fires (draft is acceptable)", async () => {
    let callCount = 0;
    const model: Model = {
      providerId: "mock",
      async *generate(): AsyncGenerator<StreamEvent> {
        callCount++;
        // First call (initial draft): returns a clean answer
        yield { type: "text_delta", delta: "clean and safe answer" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const runner = new ReflectRefineRunner({
      maxCycles: 3,
      outputGuardrails: [forbiddenPhrases(["harmful"])],
    });
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(result.answer).toBe("clean and safe answer");
    // Only 1 call (initial draft) — guardrail passed so loop stopped immediately
    expect(callCount).toBe(1);
    expect(result.cyclesUsed).toBe(0);
  });

  it("continues refining when output guardrail triggers (draft is unsafe)", async () => {
    let callCount = 0;
    const model: Model = {
      providerId: "mock",
      async *generate(): AsyncGenerator<StreamEvent> {
        callCount++;
        if (callCount === 1) {
          // Initial draft: contains forbidden phrase
          yield { type: "text_delta", delta: "this contains harmful content" };
        } else {
          // All subsequent calls: return clean answer
          yield { type: "text_delta", delta: "clean and safe answer" };
        }
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const runner = new ReflectRefineRunner({
      maxCycles: 2,
      outputGuardrails: [forbiddenPhrases(["harmful"])],
    });
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(result.answer).toBe("clean and safe answer");
    expect(result.cyclesUsed).toBe(1);
    // Initial draft + critique + refine = 3 calls minimum
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("outputGuardrails takes priority over qualitySignal", async () => {
    let qualitySignalCalled = false;
    const model: Model = {
      providerId: "mock",
      async *generate(): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", delta: "good answer" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const runner = new ReflectRefineRunner({
      maxCycles: 3,
      outputGuardrails: [forbiddenPhrases(["bad"])],
      qualitySignal: () => {
        qualitySignalCalled = true;
        return false;
      },
    });
    await runner.run(model, [{ role: "user", content: "q" }]);
    // qualitySignal should NOT be called when outputGuardrails are provided
    expect(qualitySignalCalled).toBe(false);
  });

  it("custom output guardrail can encode domain-specific quality check", async () => {
    let callCount = 0;
    const model: Model = {
      providerId: "mock",
      async *generate(): AsyncGenerator<StreamEvent> {
        callCount++;
        // Return valid JSON on second pass
        if (callCount === 1) {
          yield { type: "text_delta", delta: "not json" };
        } else {
          yield { type: "text_delta", delta: '{"result": 42}' };
        }
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    // Custom guardrail: tripwire fires when answer is not valid JSON
    const jsonGuardrail: OutputGuardrail = {
      name: "jsonCheck",
      check(answer) {
        try {
          JSON.parse(typeof answer === "string" ? answer : JSON.stringify(answer));
          return { tripwireTriggered: false };
        } catch {
          return { tripwireTriggered: true };
        }
      },
    };
    const runner = new ReflectRefineRunner({
      maxCycles: 3,
      outputGuardrails: [jsonGuardrail],
    });
    const result = await runner.run(model, [{ role: "user", content: "q" }]);
    expect(result.answer).toBe('{"result": 42}');
    expect(result.cyclesUsed).toBe(1);
  });
});
