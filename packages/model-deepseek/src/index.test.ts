import type { StreamEvent } from "@wasmagent/core/models";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
          if (i < chunks.length) return { value: chunks[i++] as OAIChunk, done: false };
          return { value: undefined as unknown as OAIChunk, done: true };
        },
      };
    },
  };
}

async function collectEvents(
  chunks: OAIChunk[],
  modelId = "deepseek-v4-pro",
  opts: Parameters<import("./index.js").DeepSeekModel["generate"]>[1] = {},
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

  const { DeepSeekModel } = await import("./index.js?t=" + Date.now() + "");
  const model = new DeepSeekModel(modelId, "test-key");

  const events: StreamEvent[] = [];
  for await (const e of model.generate([{ role: "user", content: "test" }], opts)) {
    events.push(e);
  }
  vi.doUnmock("openai");
  return events;
}

describe("DeepSeekModel", () => {
  beforeEach(() => {
    vi.resetModules();
  });

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
      {
        choices: [
          { delta: { reasoning_content: "reasoning", content: "answer" }, finish_reason: "stop" },
        ],
      },
    ]);
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas.every((e) => !e.delta?.includes("reasoning"))).toBe(true);
  });

  it("uses DEEPSEEK_BASE_URL as base URL", async () => {
    let capturedBaseURL: string | undefined;
    const MockOpenAI = vi.fn().mockImplementation((opts: Record<string, unknown>) => {
      capturedBaseURL = opts.baseURL as string;
      return {
        chat: {
          completions: {
            create: vi
              .fn()
              .mockResolvedValue(
                makeChunkStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }])
              ),
          },
        },
      };
    });
    vi.doMock("openai", () => ({ default: MockOpenAI }));
    const { DeepSeekModel, DEEPSEEK_BASE_URL } = await import("./index.js?t=" + Date.now() + "u");
    const model = new DeepSeekModel("deepseek-chat", "key");
    for await (const _ of model.generate([{ role: "user", content: "hi" }])) {
      /* consume */
    }
    expect(capturedBaseURL).toBe(DEEPSEEK_BASE_URL);
    vi.doUnmock("openai");
  });

  it("DeepSeekModels.LATEST is defined and V4_FLASH is a string", async () => {
    vi.doMock("openai", () => ({ default: vi.fn() }));
    const { DeepSeekModels } = await import("./index.js?t=" + Date.now() + "e");
    expect(typeof DeepSeekModels.LATEST).toBe("string");
    expect(typeof DeepSeekModels.V4_FLASH).toBe("string");
    expect(DeepSeekModels.V4_FLASH).toBe("deepseek-v4-flash");
    vi.doUnmock("openai");
  });

  // ── Thinking mode params ────────────────────────────────────────────────

  it("mode:off sends thinking:{type:disabled} in extra_body", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "deepseek-v4-pro",
      { thinking: { mode: "off" } },
      captured
    );
    const body = captured.ref?.extra_body as Record<string, unknown> | undefined;
    expect(body?.thinking).toMatchObject({ type: "disabled" });
  });

  it("mode:off does NOT produce thinking_delta", async () => {
    const events = await collectEvents(
      [
        { choices: [{ delta: { reasoning_content: "hidden" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ],
      "deepseek-v4-pro",
      { thinking: { mode: "off" } }
    );
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
  });

  it("default (no thinking opts) sends thinking:{type:enabled}", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "deepseek-v4-pro",
      {},
      captured
    );
    const body = captured.ref?.extra_body as Record<string, unknown> | undefined;
    expect(body?.thinking).toMatchObject({ type: "enabled" });
  });

  it("effort:max maps to effort:max in thinking body", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "deepseek-v4-pro",
      { thinking: { mode: "enabled", effort: "max" } },
      captured
    );
    const body = captured.ref?.extra_body as Record<string, unknown> | undefined;
    const thinking = body?.thinking as Record<string, unknown> | undefined;
    expect(thinking?.effort).toBe("max");
  });

  it("effort:low maps to effort:high in thinking body (DeepSeek consolidates low→high)", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "deepseek-v4-pro",
      { thinking: { mode: "enabled", effort: "low" } },
      captured
    );
    const body = captured.ref?.extra_body as Record<string, unknown> | undefined;
    const thinking = body?.thinking as Record<string, unknown> | undefined;
    expect(thinking?.effort).toBe("high");
  });
});
