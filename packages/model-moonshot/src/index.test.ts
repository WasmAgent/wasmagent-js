import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "@agentkit-js/core/models";

type OAIChunk = {
  choices: Array<{
    delta: {
      content?: string | null;
      thinking_content?: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
};

function makeChunkStream(chunks: OAIChunk[]): AsyncIterable<OAIChunk> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length) return { value: chunks[i++]!, done: false };
          return { value: undefined as unknown as OAIChunk, done: true };
        },
      };
    },
  };
}

async function collectEvents(
  chunks: OAIChunk[],
  modelId = "kimi-k2-6",
  opts: Record<string, unknown> = {}
): Promise<{ events: StreamEvent[]; capturedParams: Record<string, unknown> }> {
  const mockCreate = vi.fn().mockResolvedValue(makeChunkStream(chunks));
  const MockOpenAI = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
  vi.doMock("openai", () => ({ default: MockOpenAI }));

  const { MoonshotModel } = await import("./index.js?t=" + Date.now());
  const model = new MoonshotModel(modelId, { apiKey: "test-key", ...opts });

  const events: StreamEvent[] = [];
  for await (const e of model.generate([{ role: "user", content: "test" }])) {
    events.push(e);
  }
  vi.doUnmock("openai");
  return { events, capturedParams: mockCreate.mock.calls[0]?.[0] as Record<string, unknown> };
}

describe("MoonshotModel", () => {
  beforeEach(() => { vi.resetModules(); });

  it("emits text_delta for content", async () => {
    const { events } = await collectEvents([
      { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.delta)).toEqual(["Hello"]);
  });

  it("emits thinking_delta for thinking_content on K2.6", async () => {
    const { events } = await collectEvents([
      { choices: [{ delta: { thinking_content: "hmm..." }, finish_reason: null }] },
      { choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }] },
    ], "kimi-k2-6");
    expect(events.filter((e) => e.type === "thinking_delta")[0]?.delta).toBe("hmm...");
  });

  it("does NOT emit thinking_delta for v1-* models (preserveThinking=false by default)", async () => {
    const { events } = await collectEvents([
      { choices: [{ delta: { thinking_content: "ignored" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ], "moonshot-v1-128k");
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
  });

  it("sends enable_thinking=true for K2.6", async () => {
    const { capturedParams } = await collectEvents([
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ], "kimi-k2-6");
    expect(capturedParams["enable_thinking"]).toBe(true);
  });

  it("KimiModels.LATEST is defined", async () => {
    vi.doMock("openai", () => ({ default: vi.fn() }));
    const { KimiModels } = await import("./index.js?t=" + Date.now() + "e");
    expect(typeof KimiModels.LATEST).toBe("string");
    vi.doUnmock("openai");
  });
});
