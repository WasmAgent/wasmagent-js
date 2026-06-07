import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "@agentkit-js/core/models";

type OAIChunk = {
  choices: Array<{
    delta: { content?: string | null };
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

describe("MiniMaxModel", () => {
  beforeEach(() => { vi.resetModules(); });

  it("emits text_delta for content", async () => {
    const mockCreate = vi.fn().mockResolvedValue(makeChunkStream([
      { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]));
    vi.doMock("openai", () => ({ default: vi.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })) }));
    const { MiniMaxModel } = await import("./index.js?t=" + Date.now());
    const model = new MiniMaxModel("minimax-text-01", "key");
    const events: StreamEvent[] = [];
    for await (const e of model.generate([{ role: "user", content: "hi" }])) events.push(e);
    expect(events.filter((e) => e.type === "text_delta")[0]?.delta).toBe("Hello");
    vi.doUnmock("openai");
  });

  it("emits stop event", async () => {
    const mockCreate = vi.fn().mockResolvedValue(makeChunkStream([
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]));
    vi.doMock("openai", () => ({ default: vi.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })) }));
    const { MiniMaxModel } = await import("./index.js?t=" + Date.now() + "s");
    const model = new MiniMaxModel("minimax-m3", "key");
    const events: StreamEvent[] = [];
    for await (const e of model.generate([{ role: "user", content: "hi" }])) events.push(e);
    expect(events.find((e) => e.type === "stop")?.stopReason).toBe("end_turn");
    vi.doUnmock("openai");
  });

  it("MiniMaxModels.LATEST is defined", async () => {
    vi.doMock("openai", () => ({ default: vi.fn() }));
    const { MiniMaxModels } = await import("./index.js?t=" + Date.now() + "e");
    expect(typeof MiniMaxModels.LATEST).toBe("string");
    vi.doUnmock("openai");
  });
});
