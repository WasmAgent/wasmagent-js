import type { StreamEvent } from "@agentkit-js/core/models";
import { beforeEach, describe, expect, it, vi } from "vitest";

type OAIChunk = {
  choices: Array<{
    delta: {
      content?: string | null;
      reasoning_details?: Array<{ type?: string; text?: string }> | null;
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
  modelId = "MiniMax-M3",
  opts: Parameters<import("./index.js").MiniMaxModel["generate"]>[1] = {},
  captureParams?: { ref: Record<string, unknown> | null }
): Promise<StreamEvent[]> {
  const mockCreate = vi.fn().mockImplementation((params: Record<string, unknown>) => {
    if (captureParams) captureParams.ref = params;
    return Promise.resolve(makeChunkStream(chunks));
  });
  vi.doMock("openai", () => ({
    default: vi.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })),
  }));
  const { MiniMaxModel } = await import("./index.js?t=" + Date.now() + "");
  const model = new MiniMaxModel(modelId, "key");
  const events: StreamEvent[] = [];
  for await (const e of model.generate([{ role: "user", content: "hi" }], opts)) events.push(e);
  vi.doUnmock("openai");
  return events;
}

describe("MiniMaxModel", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // ── Basic events ────────────────────────────────────────────────────────

  it("emits text_delta for content", async () => {
    const events = await collectEvents(
      [
        { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ],
      "minimax-text-01"
    );
    expect(events.filter((e) => e.type === "text_delta")[0]?.delta).toBe("Hello");
  });

  it("emits stop event", async () => {
    const events = await collectEvents([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    expect(events.find((e) => e.type === "stop")?.stopReason).toBe("end_turn");
  });

  // ── L11-1: Base URL ──────────────────────────────────────────────────────

  it("default uses MINIMAX_BASE_URL (api.minimax.io)", async () => {
    let capturedBase: string | undefined;
    const MockOpenAI = vi.fn().mockImplementation((opts: Record<string, unknown>) => {
      capturedBase = opts.baseURL as string;
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
    const { MiniMaxModel, MINIMAX_BASE_URL } = await import("./index.js?t=" + Date.now() + "b");
    const model = new MiniMaxModel("MiniMax-M3", "key");
    for await (const _ of model.generate([{ role: "user", content: "hi" }])) {
      /* consume */
    }
    expect(capturedBase).toBe(MINIMAX_BASE_URL);
    expect(MINIMAX_BASE_URL).toBe("https://api.minimax.io/v1");
    vi.doUnmock("openai");
  });

  it("region:cn uses MINIMAX_CN_BASE_URL (api.minimaxi.com)", async () => {
    let capturedBase: string | undefined;
    const MockOpenAI = vi.fn().mockImplementation((opts: Record<string, unknown>) => {
      capturedBase = opts.baseURL as string;
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
    const { MiniMaxModel, MINIMAX_CN_BASE_URL } = await import("./index.js?t=" + Date.now() + "c");
    const model = new MiniMaxModel("MiniMax-M3", { region: "cn" });
    for await (const _ of model.generate([{ role: "user", content: "hi" }])) {
      /* consume */
    }
    expect(capturedBase).toBe(MINIMAX_CN_BASE_URL);
    vi.doUnmock("openai");
  });

  // ── L11-2: M2+ reasoning — reasoning_split=true (default) ───────────────

  it("M3 default: sends reasoning_split:true in params", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "MiniMax-M3",
      {},
      captured
    );
    expect(captured.ref?.reasoning_split).toBe(true);
  });

  it("M3: reasoning_details → thinking_delta (reasoning_split=true)", async () => {
    const events = await collectEvents([
      {
        choices: [
          {
            delta: { reasoning_details: [{ type: "thinking", text: "Let me think" }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }] },
    ]);
    const thinking = events.filter((e) => e.type === "thinking_delta");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]?.delta).toBe("Let me think");
    const text = events.filter((e) => e.type === "text_delta");
    expect(text[0]?.delta).toBe("Answer");
  });

  it("reasoning_details does NOT appear in text_delta", async () => {
    const events = await collectEvents([
      {
        choices: [
          {
            delta: { reasoning_details: [{ text: "reasoning" }], content: "answer" },
            finish_reason: "stop",
          },
        ],
      },
    ]);
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas.every((e) => !e.delta?.includes("reasoning"))).toBe(true);
  });

  it("minimax-text-01: no reasoning_split, no thinking_delta from content", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    const events = await collectEvents(
      [{ choices: [{ delta: { content: "plain text" }, finish_reason: "stop" }] }],
      "minimax-text-01",
      {},
      captured
    );
    expect(captured.ref?.reasoning_split).toBeUndefined();
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
  });

  // ── L11-2: M2+ reasoning — reasoning_split=false (<think> parsing) ──────

  it("reasoning_split=false: <think>...</think> in content → thinking_delta", async () => {
    const mockCreate = vi.fn().mockImplementation(() =>
      Promise.resolve(
        makeChunkStream([
          {
            choices: [
              {
                delta: { content: "<think>inner reasoning</think>answer" },
                finish_reason: "stop",
              },
            ],
          },
        ])
      )
    );
    vi.doMock("openai", () => ({
      default: vi
        .fn()
        .mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })),
    }));
    const { MiniMaxModel } = await import("./index.js?t=" + Date.now() + "t");
    const model = new MiniMaxModel("MiniMax-M3", { reasoningSplit: false });
    const events: StreamEvent[] = [];
    for await (const e of model.generate([{ role: "user", content: "hi" }])) events.push(e);
    vi.doUnmock("openai");
    const thinking = events.filter((e) => e.type === "thinking_delta");
    expect(thinking[0]?.delta).toBe("inner reasoning");
    const text = events.filter((e) => e.type === "text_delta");
    expect(text.some((e) => e.delta?.includes("answer"))).toBe(true);
    expect(text.every((e) => !e.delta?.includes("<think>") && !e.delta?.includes("</think>"))).toBe(
      true
    );
  });

  it("reasoning_split=false: <think> split across chunks handled correctly", async () => {
    const mockCreate = vi.fn().mockImplementation(() =>
      Promise.resolve(
        makeChunkStream([
          { choices: [{ delta: { content: "<thi" }, finish_reason: null }] },
          {
            choices: [
              { delta: { content: "nk>thinking text</think>done" }, finish_reason: "stop" },
            ],
          },
        ])
      )
    );
    vi.doMock("openai", () => ({
      default: vi
        .fn()
        .mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })),
    }));
    const { MiniMaxModel } = await import("./index.js?t=" + Date.now() + "x");
    const model = new MiniMaxModel("MiniMax-M3", { reasoningSplit: false });
    const events: StreamEvent[] = [];
    for await (const e of model.generate([{ role: "user", content: "hi" }])) events.push(e);
    vi.doUnmock("openai");
    const thinking = events.filter((e) => e.type === "thinking_delta");
    expect(thinking.map((e) => e.delta).join("")).toBe("thinking text");
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => e.delta)
      .join("");
    expect(text).toContain("done");
  });

  it("getModelMeta for MiniMax-M2.7 shows isReasoning:true", async () => {
    vi.doMock("openai", () => ({ default: vi.fn() }));
    const { getModelMeta } = await import("@agentkit-js/core/models");
    expect(getModelMeta("MiniMax-M2.7").isReasoning).toBe(true);
    vi.doUnmock("openai");
  });

  // ── Model constants ──────────────────────────────────────────────────────

  it("MiniMaxModels.LATEST is defined as MiniMax-M3", async () => {
    vi.doMock("openai", () => ({ default: vi.fn() }));
    const { MiniMaxModels } = await import("./index.js?t=" + Date.now() + "e");
    expect(typeof MiniMaxModels.LATEST).toBe("string");
    expect(MiniMaxModels.LATEST).toBe("MiniMax-M3");
    vi.doUnmock("openai");
  });
});
