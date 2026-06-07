import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "@agentkit-js/core/models";

type OAIChunk = {
  choices: Array<{
    delta: {
      content?: string | null;
      thinking_content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
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
  modelId = "kimi-k2.6",
  opts: Parameters<import("./index.js").MoonshotModel["generate"]>[1] = {},
  captureParams?: { ref: Record<string, unknown> | null }
): Promise<StreamEvent[]> {
  const mockCreate = vi.fn().mockImplementation((params: Record<string, unknown>) => {
    if (captureParams) captureParams.ref = params;
    return Promise.resolve(makeChunkStream(chunks));
  });
  const MockOpenAI = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
  vi.doMock("openai", () => ({ default: MockOpenAI }));

  const { MoonshotModel } = await import("./index.js?t=" + Date.now());
  const model = new MoonshotModel(modelId, "test-key");

  const events: StreamEvent[] = [];
  for await (const e of model.generate([{ role: "user", content: "test" }], opts)) {
    events.push(e);
  }
  vi.doUnmock("openai");
  return events;
}

describe("MoonshotModel", () => {
  beforeEach(() => { vi.resetModules(); });

  it("emits text_delta for content", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.delta)).toEqual(["Hello"]);
  });

  // ── L8-1: Reasoning field version detection ─────────────────────────────

  it("K2.6 (dot): emits thinking_delta from delta.reasoning field", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { reasoning: "K2.6 reasoning text" }, finish_reason: null }] },
      { choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }] },
    ], "kimi-k2.6");
    const thinking = events.filter((e) => e.type === "thinking_delta");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]?.delta).toBe("K2.6 reasoning text");
  });

  it("K2 (dash): emits thinking_delta from delta.reasoning_content field", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { reasoning_content: "K2 reasoning text" }, finish_reason: null }] },
      { choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }] },
    ], "kimi-k2-6");
    const thinking = events.filter((e) => e.type === "thinking_delta");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]?.delta).toBe("K2 reasoning text");
  });

  it("reasoning field does NOT appear in text_delta", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { reasoning: "reasoning", content: "answer" }, finish_reason: "stop" }] },
    ], "kimi-k2.6");
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas.every((e) => !e.delta?.includes("reasoning"))).toBe(true);
  });

  it("does NOT emit thinking_delta for v1-* models (preserveThinking=false by default)", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { reasoning: "ignored", reasoning_content: "ignored" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ], "moonshot-v1-128k");
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
  });

  // ── L8-2: Thinking params — thinking:{type} via extra_body ───────────────

  it("K2.6 default: sends thinking:{type:enabled} in extra_body", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "kimi-k2.6",
      {},
      captured
    );
    const body = captured.ref?.["extra_body"] as Record<string, unknown> | undefined;
    expect(body?.["thinking"]).toMatchObject({ type: "enabled" });
  });

  it("mode:off sends thinking:{type:disabled}", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "kimi-k2.6",
      { thinking: { mode: "off" } },
      captured
    );
    const body = captured.ref?.["extra_body"] as Record<string, unknown> | undefined;
    expect(body?.["thinking"]).toMatchObject({ type: "disabled" });
  });

  it("mode:off does NOT produce thinking_delta", async () => {
    const events = await collectEvents(
      [
        { choices: [{ delta: { reasoning: "hidden" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ],
      "kimi-k2.6",
      { thinking: { mode: "off" } }
    );
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
  });

  // ── L8-3: Model constants ────────────────────────────────────────────────

  it("KimiModels.LATEST is a string pointing to k2.6", async () => {
    vi.doMock("openai", () => ({ default: vi.fn() }));
    const { KimiModels } = await import("./index.js?t=" + Date.now() + "e");
    expect(typeof KimiModels.LATEST).toBe("string");
    expect(KimiModels.LATEST).toBe("kimi-k2.6");
    vi.doUnmock("openai");
  });
});
