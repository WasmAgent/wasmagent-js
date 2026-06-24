import { describe, expect, test } from "bun:test";
import type { GenerateOptions, Model, ModelMessage, StreamEvent } from "@wasmagent/core/models";
import { ModelRepairLLM } from "./ModelRepairLLM.js";

/** Minimal scriptable Model fake — yields the events you hand it. */
function scriptedModel(
  emit: (msgs: ModelMessage[], opts: GenerateOptions) => StreamEvent[],
  spy?: { last?: { msgs: ModelMessage[]; opts: GenerateOptions } }
): Model {
  return {
    providerId: "test-fake",
    capabilities: {
      localEndpoint: true,
      metered: false,
      supportsGrammar: false,
      cacheStrategy: "none",
    },
    async *generate(messages, opts = {}) {
      if (spy) spy.last = { msgs: messages, opts };
      for (const ev of emit(messages, opts)) yield ev;
    },
  };
}

describe("ModelRepairLLM", () => {
  test("concatenates text_delta events into the response text", async () => {
    const model = scriptedModel(() => [
      { type: "text_delta", delta: "hello " },
      { type: "text_delta", delta: "world" },
      { type: "stop", stopReason: "end_turn" },
    ]);
    const llm = new ModelRepairLLM({ model });
    const r = await llm.complete({ prompt: "x" });
    expect(r.text).toBe("hello world");
  });

  test("captures usage from the usage event", async () => {
    const model = scriptedModel(() => [
      { type: "text_delta", delta: "ok" },
      { type: "usage", usage: { inputTokens: 42, outputTokens: 7 } as never },
      { type: "stop", stopReason: "end_turn" },
    ]);
    const llm = new ModelRepairLLM({ model });
    const r = await llm.complete({ prompt: "x" });
    expect(r.usage?.prompt_tokens).toBe(42);
    expect(r.usage?.completion_tokens).toBe(7);
  });

  test("includes default system prompt unless disabled", async () => {
    const spy: { last?: { msgs: ModelMessage[]; opts: GenerateOptions } } = {};
    const model = scriptedModel(
      () => [
        { type: "text_delta", delta: "y" },
        { type: "stop", stopReason: "end_turn" },
      ],
      spy
    );
    const llm = new ModelRepairLLM({ model });
    await llm.complete({ prompt: "rewrite this" });
    expect(spy.last?.msgs[0]?.role).toBe("system");
    expect(spy.last?.msgs[1]?.role).toBe("user");
    expect(spy.last?.msgs[1]?.content).toBe("rewrite this");
  });

  test("system prompt can be disabled with null", async () => {
    const spy: { last?: { msgs: ModelMessage[]; opts: GenerateOptions } } = {};
    const model = scriptedModel(() => [{ type: "stop", stopReason: "end_turn" }], spy);
    const llm = new ModelRepairLLM({ model, systemPrompt: null });
    await llm.complete({ prompt: "x" });
    expect(spy.last?.msgs).toHaveLength(1);
    expect(spy.last?.msgs[0]?.role).toBe("user");
  });

  test("passes max_tokens and temperature through to generate opts", async () => {
    const spy: { last?: { msgs: ModelMessage[]; opts: GenerateOptions } } = {};
    const model = scriptedModel(() => [{ type: "stop", stopReason: "end_turn" }], spy);
    const llm = new ModelRepairLLM({ model });
    await llm.complete({ prompt: "x", max_tokens: 256, temperature: 0.1 });
    expect(spy.last?.opts.maxTokens).toBe(256);
    expect(spy.last?.opts.temperature).toBe(0.1);
  });

  test("ignores thinking_delta and tool_call events", async () => {
    const model = scriptedModel(() => [
      { type: "thinking_delta", delta: "[hidden]" },
      { type: "text_delta", delta: "visible" },
      { type: "stop", stopReason: "end_turn" },
    ]);
    const llm = new ModelRepairLLM({ model });
    const r = await llm.complete({ prompt: "x" });
    expect(r.text).toBe("visible");
  });
});
