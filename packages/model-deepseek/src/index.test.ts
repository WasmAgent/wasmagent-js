import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "@agentkit-js/core/models";

type OAIChunk = {
  choices: Array<{
    delta: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
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
  modelId = "deepseek-reasoner"
): Promise<StreamEvent[]> {
  const mockCreate = vi.fn().mockResolvedValue(makeChunkStream(chunks));
  const MockOpenAI = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
  vi.doMock("openai", () => ({ default: MockOpenAI }));

  const { DeepSeekModel } = await import("./index.js?t=" + Date.now());
  const model = new DeepSeekModel(modelId, "test-key");

  const events: StreamEvent[] = [];
  for await (const e of model.generate([{ role: "user", content: "test" }])) {
    events.push(e);
  }
  vi.doUnmock("openai");
  return events;
}

describe("DeepSeekModel", () => {
  beforeEach(() => { vi.resetModules(); });

  it("emits text_delta for normal content", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.delta)).toEqual(["Hello"]);
  });

  it("emits thinking_delta for reasoning_content (separate from main content)", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { reasoning_content: "Let me think..." }, finish_reason: null }] },
      { choices: [{ delta: { content: "Answer" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const thinking = events.filter((e) => e.type === "thinking_delta");
    const text = events.filter((e) => e.type === "text_delta");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]?.delta).toBe("Let me think...");
    expect(text[0]?.delta).toBe("Answer");
  });

  it("reasoning_content does NOT appear in text_delta", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { reasoning_content: "reasoning", content: "answer" }, finish_reason: "stop" }] },
    ]);
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas.every((e) => !e.delta?.includes("reasoning"))).toBe(true);
  });

  it("uses DEEPSEEK_BASE_URL as base URL", async () => {
    let capturedBaseURL: string | undefined;
    const MockOpenAI = vi.fn().mockImplementation((opts: Record<string, unknown>) => {
      capturedBaseURL = opts["baseURL"] as string;
      return { chat: { completions: { create: vi.fn().mockResolvedValue(makeChunkStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }])) } } };
    });
    vi.doMock("openai", () => ({ default: MockOpenAI }));
    const { DeepSeekModel, DEEPSEEK_BASE_URL } = await import("./index.js?t=" + Date.now() + "u");
    const model = new DeepSeekModel("deepseek-chat", "key");
    for await (const _ of model.generate([{ role: "user", content: "hi" }])) { /* consume */ }
    expect(capturedBaseURL).toBe(DEEPSEEK_BASE_URL);
    vi.doUnmock("openai");
  });

  it("DeepSeekModels.LATEST is defined", async () => {
    vi.doMock("openai", () => ({ default: vi.fn() }));
    const { DeepSeekModels } = await import("./index.js?t=" + Date.now() + "e");
    expect(typeof DeepSeekModels.LATEST).toBe("string");
    vi.doUnmock("openai");
  });
});
