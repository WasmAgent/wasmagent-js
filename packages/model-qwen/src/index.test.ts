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
  opts: Parameters<import("./index.js").QwenModel["generate"]>[1] = {},
  captureParams?: { ref: Record<string, unknown> | null }
): Promise<StreamEvent[]> {
  const mockCreate = vi.fn().mockImplementation((params: Record<string, unknown>) => {
    if (captureParams) captureParams.ref = params;
    return Promise.resolve(makeChunkStream(chunks));
  });
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

  // ── L9-1: Thinking params ────────────────────────────────────────────────

  it("default qwen3: sends enable_thinking:true", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents([{ choices: [{ delta: {}, finish_reason: "stop" }] }], "qwen3-max", {}, captured);
    expect(captured.ref?.["enable_thinking"]).toBe(true);
  });

  it("mode:off sends enable_thinking:false", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "qwen3-max",
      { thinking: { mode: "off" } },
      captured
    );
    expect(captured.ref?.["enable_thinking"]).toBe(false);
  });

  it("mode:off suppresses thinking_delta", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { reasoning_content: "hidden" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ], "qwen3-max", { thinking: { mode: "off" } });
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
  });

  it("effort:high maps to thinking_budget", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "qwen3-max",
      { thinking: { mode: "enabled", effort: "high" } },
      captured
    );
    expect(typeof captured.ref?.["thinking_budget"]).toBe("number");
    expect((captured.ref?.["thinking_budget"] as number) > 0).toBe(true);
  });

  it("explicit budgetTokens overrides effort budget", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "qwen3-max",
      { thinking: { mode: "enabled", budgetTokens: 8000 } },
      captured
    );
    expect(captured.ref?.["thinking_budget"]).toBe(8000);
  });

  // ── L9-2: Region ─────────────────────────────────────────────────────────

  it("region:intl uses intl base URL", async () => {
    let capturedBase: string | undefined;
    const MockOpenAI = vi.fn().mockImplementation((opts: Record<string, unknown>) => {
      capturedBase = opts["baseURL"] as string;
      return { chat: { completions: { create: vi.fn().mockResolvedValue(makeChunkStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }])) } } };
    });
    vi.doMock("openai", () => ({ default: MockOpenAI }));
    const { QwenModel, QWEN_INTL_BASE_URL } = await import("./index.js?t=" + Date.now() + "r");
    const model = new QwenModel("qwen3-max", { region: "intl" });
    for await (const _ of model.generate([{ role: "user", content: "hi" }])) { /* consume */ }
    expect(capturedBase).toBe(QWEN_INTL_BASE_URL);
    vi.doUnmock("openai");
  });

  it("default region uses CN base URL", async () => {
    let capturedBase: string | undefined;
    const MockOpenAI = vi.fn().mockImplementation((opts: Record<string, unknown>) => {
      capturedBase = opts["baseURL"] as string;
      return { chat: { completions: { create: vi.fn().mockResolvedValue(makeChunkStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }])) } } };
    });
    vi.doMock("openai", () => ({ default: MockOpenAI }));
    const { QwenModel, QWEN_BASE_URL } = await import("./index.js?t=" + Date.now() + "s");
    const model = new QwenModel("qwen3-max", "key");
    for await (const _ of model.generate([{ role: "user", content: "hi" }])) { /* consume */ }
    expect(capturedBase).toBe(QWEN_BASE_URL);
    vi.doUnmock("openai");
  });

  it("QwenModels.LATEST is defined", async () => {
    vi.doMock("openai", () => ({ default: vi.fn() }));
    const { QwenModels } = await import("./index.js?t=" + Date.now() + "e");
    expect(typeof QwenModels.LATEST).toBe("string");
    vi.doUnmock("openai");
  });
});
