import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "@agentkit-js/core/models";

type OAIChunk = {
  choices: Array<{
    delta: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
};

function makeChunkStream(chunks: OAIChunk[]): AsyncIterable<OAIChunk> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return { async next() { if (i < chunks.length) return { value: chunks[i++]!, done: false }; return { value: undefined as unknown as OAIChunk, done: true }; } };
    },
  };
}

async function collectEvents(
  chunks: OAIChunk[],
  modelId = "qwen3-max",
  opts: Parameters<import("./index.js").QwenModel["generate"]>[1] = {}
): Promise<StreamEvent[]> {
  const mockCreate = vi.fn().mockResolvedValue(makeChunkStream(chunks));
  vi.doMock("openai", () => ({ default: vi.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })) }));
  const { QwenModel } = await import("./index.js?t=" + Date.now());
  const model = new QwenModel(modelId, "key");
  const events: StreamEvent[] = [];
  for await (const e of model.generate([{ role: "user", content: "x" }], opts)) events.push(e);
  vi.doUnmock("openai");
  return events;
}

describe("QwenModel", () => {
  beforeEach(() => { vi.resetModules(); });

  it("emits text_delta for content", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] },
    ]);
    expect(events.filter((e) => e.type === "text_delta")[0]?.delta).toBe("hi");
  });

  it("emits thinking_delta for qwen3-max", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { reasoning_content: "reasoning" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ], "qwen3-max");
    expect(events.filter((e) => e.type === "thinking_delta")[0]?.delta).toBe("reasoning");
  });

  it("does NOT emit thinking_delta for qwen2.5-*", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { reasoning_content: "skip" }, finish_reason: "stop" }] },
    ], "qwen2.5-72b-instruct");
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
  });

  it("opts.thinking.mode:off suppresses thinking_delta even on qwen3 model", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { reasoning_content: "hidden" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ], "qwen3-max", { thinking: { mode: "off" } });
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
  });

  it("QwenModels.LATEST is defined", async () => {
    vi.doMock("openai", () => ({ default: vi.fn() }));
    const { QwenModels } = await import("./index.js?t=" + Date.now() + "e");
    expect(typeof QwenModels.LATEST).toBe("string");
    vi.doUnmock("openai");
  });
});
