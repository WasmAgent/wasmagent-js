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

async function collectEvents(chunks: OAIChunk[], modelId = "glm-5-1"): Promise<StreamEvent[]> {
  const mockCreate = vi.fn().mockResolvedValue(makeChunkStream(chunks));
  vi.doMock("openai", () => ({ default: vi.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })) }));
  const { ZhipuModel } = await import("./index.js?t=" + Date.now());
  const model = new ZhipuModel(modelId, "key");
  const events: StreamEvent[] = [];
  for await (const e of model.generate([{ role: "user", content: "x" }])) events.push(e);
  vi.doUnmock("openai");
  return events;
}

describe("ZhipuModel", () => {
  beforeEach(() => { vi.resetModules(); });

  it("emits text_delta for content", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    expect(events.filter((e) => e.type === "text_delta")[0]?.delta).toBe("Hi");
  });

  it("emits thinking_delta for reasoning_content on glm-5-1", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { reasoning_content: "thinking..." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ], "glm-5-1");
    expect(events.filter((e) => e.type === "thinking_delta")[0]?.delta).toBe("thinking...");
  });

  it("does NOT emit thinking_delta for glm-4-plus", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { reasoning_content: "ignored" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ], "glm-4-plus");
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
  });

  it("GLMModels.LATEST is defined", async () => {
    vi.doMock("openai", () => ({ default: vi.fn() }));
    const { GLMModels } = await import("./index.js?t=" + Date.now() + "e");
    expect(typeof GLMModels.LATEST).toBe("string");
    vi.doUnmock("openai");
  });
});
