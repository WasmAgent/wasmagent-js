import type { StreamEvent } from "@agentkit-js/core/models";
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
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
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
  modelId = "doubao-seed-1-6-251015",
  opts: Parameters<import("./index.js").DoubaoModel["generate"]>[1] = {},
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

  const { DoubaoModel } = await import("./index.js?t=" + Date.now() + "");
  const model = new DoubaoModel(modelId, "test-key");

  const events: StreamEvent[] = [];
  for await (const e of model.generate([{ role: "user", content: "test" }], opts)) {
    events.push(e);
  }
  vi.doUnmock("openai");
  return events;
}

describe("DoubaoModel", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // ── Basic stream events ─────────────────────────────────────────────────

  it("emits text_delta for normal content", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.delta)).toEqual(["Hello"]);
  });

  it("emits thinking_delta for reasoning_content", async () => {
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

  // ── Thinking mode params ────────────────────────────────────────────────

  it("default: emits thinking:enabled in extra_body", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "doubao-seed-1-6-251015",
      {},
      captured
    );
    const body = captured.ref?.extra_body as Record<string, unknown> | undefined;
    expect(body?.thinking).toMatchObject({ type: "enabled" });
  });

  it("mode:off sends thinking:{type:disabled}", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "doubao-seed-1-6-251015",
      { thinking: { mode: "off" } },
      captured
    );
    const body = captured.ref?.extra_body as Record<string, unknown> | undefined;
    expect(body?.thinking).toMatchObject({ type: "disabled" });
  });

  it("mode:off does NOT produce thinking_delta", async () => {
    const events = await collectEvents(
      [
        { choices: [{ delta: { reasoning_content: "should be hidden" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ],
      "doubao-seed-1-6-251015",
      { thinking: { mode: "off" } }
    );
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
  });

  it("mode:adaptive on auto-capable model sends type:auto", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "doubao-seed-2-0-pro",
      { thinking: { mode: "adaptive" } },
      captured
    );
    const body = captured.ref?.extra_body as Record<string, unknown> | undefined;
    expect(body?.thinking).toMatchObject({ type: "auto" });
  });

  it("mode:adaptive on non-auto model downgrades to enabled", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "doubao-seed-1-6-251015",
      { thinking: { mode: "adaptive" } },
      captured
    );
    const body = captured.ref?.extra_body as Record<string, unknown> | undefined;
    expect(body?.thinking).toMatchObject({ type: "enabled" });
  });

  // ── Effort → thinking level mapping ────────────────────────────────────

  it("effort:low maps to level:low", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "doubao-seed-1-6-251015",
      { thinking: { mode: "enabled", effort: "low" } },
      captured
    );
    const body = captured.ref?.extra_body as Record<string, unknown> | undefined;
    const thinking = body?.thinking as Record<string, unknown> | undefined;
    expect(thinking?.level).toBe("low");
  });

  it("effort:medium maps to level:medium", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "doubao-seed-1-6-251015",
      { thinking: { mode: "enabled", effort: "medium" } },
      captured
    );
    const body = captured.ref?.extra_body as Record<string, unknown> | undefined;
    const thinking = body?.thinking as Record<string, unknown> | undefined;
    expect(thinking?.level).toBe("medium");
  });

  it("effort:high maps to level:high", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "doubao-seed-1-6-251015",
      { thinking: { mode: "enabled", effort: "high" } },
      captured
    );
    const body = captured.ref?.extra_body as Record<string, unknown> | undefined;
    const thinking = body?.thinking as Record<string, unknown> | undefined;
    expect(thinking?.level).toBe("high");
  });

  it("effort:minimal maps to level:minimal", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "doubao-seed-1-6-251015",
      { thinking: { mode: "enabled", effort: "minimal" } },
      captured
    );
    const body = captured.ref?.extra_body as Record<string, unknown> | undefined;
    const thinking = body?.thinking as Record<string, unknown> | undefined;
    expect(thinking?.level).toBe("minimal");
  });

  // ── Cache / token usage ─────────────────────────────────────────────────

  it("cacheReadTokens populated from cached_tokens", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { content: "x" }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 128 },
        },
      },
    ]);
    const usageEvent = events.find((e) => e.type === "usage");
    expect(usageEvent?.usage?.cacheReadTokens).toBe(128);
    expect(usageEvent?.usage?.inputTokens).toBe(100);
    expect(usageEvent?.usage?.outputTokens).toBe(20);
  });

  it("no error and no cacheReadTokens when prompt_tokens_details absent", async () => {
    const events = await collectEvents([
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    ]);
    const usageEvent = events.find((e) => e.type === "usage");
    expect(usageEvent?.usage?.cacheReadTokens).toBeUndefined();
  });

  // ── Capabilities & constants ────────────────────────────────────────────

  it("uses DOUBAO_BASE_URL as base URL", async () => {
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
    const { DoubaoModel, DOUBAO_BASE_URL } = await import("./index.js?t=" + Date.now() + "u");
    const model = new DoubaoModel("doubao-seed-1-6-251015", "key");
    for await (const _ of model.generate([{ role: "user", content: "hi" }])) {
      /* consume */
    }
    expect(capturedBaseURL).toBe(DOUBAO_BASE_URL);
    vi.doUnmock("openai");
  });

  it("DoubaoModels.LATEST is a string", async () => {
    vi.doMock("openai", () => ({ default: vi.fn() }));
    const { DoubaoModels } = await import("./index.js?t=" + Date.now() + "e");
    expect(typeof DoubaoModels.LATEST).toBe("string");
    vi.doUnmock("openai");
  });

  it("default cacheStrategy is auto-prefix", async () => {
    vi.doMock("openai", () => ({ default: vi.fn() }));
    const { DoubaoModel } = await import("./index.js?t=" + Date.now() + "c1");
    const model = new DoubaoModel("doubao-seed-1-6-251015", "key");
    expect(model.capabilities.cacheStrategy).toBe("auto-prefix");
    vi.doUnmock("openai");
  });

  it("useContextApi:true sets cacheStrategy to ark-context", async () => {
    vi.doMock("openai", () => ({ default: vi.fn() }));
    const { DoubaoModel } = await import("./index.js?t=" + Date.now() + "c2");
    const model = new DoubaoModel("doubao-seed-1-6-251015", { useContextApi: true });
    expect(model.capabilities.cacheStrategy).toBe("ark-context");
    vi.doUnmock("openai");
  });

  // ── Tool call accumulation ──────────────────────────────────────────────

  it("accumulates tool_calls and emits tool_call + stop:tool_use", async () => {
    const events = await collectEvents([
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call1", function: { name: "fn", arguments: '{"k"' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: ':"v"}' } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const toolCall = events.find((e) => e.type === "tool_call");
    const stop = events.find((e) => e.type === "stop");
    expect(toolCall?.toolCall?.name).toBe("fn");
    expect(toolCall?.toolCall?.input).toEqual({ k: "v" });
    expect(stop?.stopReason).toBe("tool_use");
  });
});
