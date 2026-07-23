import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { StreamEvent } from "@wasmagent/core/models";

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

// ── Shared mutable mock state ────────────────────────────────────────────────

/** Controls what chat.completions.create returns for the current test. */
let mockCreateImpl: ((params: Record<string, unknown>) => unknown) | null = null;
/** Captures the baseURL passed to the OpenAI constructor in the current test. */
let capturedBaseURL: string | undefined;

mock.module("openai", () => {
  return {
    default: class MockOpenAI {
      constructor(opts?: Record<string, unknown>) {
        capturedBaseURL = opts?.baseURL as string | undefined;
      }
      chat = {
        completions: {
          create: mock((params: Record<string, unknown>) =>
            mockCreateImpl ? mockCreateImpl(params) : Promise.resolve(makeChunkStream([]))
          ),
        },
      };
    },
  };
});

import { getModelMeta } from "@wasmagent/core/models";
// Import the module AFTER mock.module() so the mock is in effect.
import { MINIMAX_BASE_URL, MINIMAX_CN_BASE_URL, MiniMaxModel, MiniMaxModels } from "./minimax.js";

// ── Helper ───────────────────────────────────────────────────────────────────

async function collectEvents(
  chunks: OAIChunk[],
  modelId = "MiniMax-M3",
  opts: Parameters<MiniMaxModel["generate"]>[1] = {},
  captureParams?: { ref: Record<string, unknown> | null }
): Promise<StreamEvent[]> {
  mockCreateImpl = (params: Record<string, unknown>) => {
    if (captureParams) captureParams.ref = params;
    return Promise.resolve(makeChunkStream(chunks));
  };
  const model = new MiniMaxModel(modelId, "key");
  const events: StreamEvent[] = [];
  for await (const e of model.generate([{ role: "user", content: "hi" }], opts)) events.push(e);
  return events;
}

describe("MiniMaxModel", () => {
  beforeEach(() => {
    mockCreateImpl = null;
    capturedBaseURL = undefined;
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
    mockCreateImpl = () =>
      Promise.resolve(makeChunkStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }]));
    const model = new MiniMaxModel("MiniMax-M3", "key");
    for await (const _ of model.generate([{ role: "user", content: "hi" }])) {
      /* consume */
    }
    expect(capturedBaseURL).toBe(MINIMAX_BASE_URL);
    expect(MINIMAX_BASE_URL).toBe("https://api.minimax.io/v1");
  });

  it("region:cn uses MINIMAX_CN_BASE_URL (api.minimaxi.com)", async () => {
    mockCreateImpl = () =>
      Promise.resolve(makeChunkStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }]));
    const model = new MiniMaxModel("MiniMax-M3", { region: "cn" });
    for await (const _ of model.generate([{ role: "user", content: "hi" }])) {
      /* consume */
    }
    expect(capturedBaseURL).toBe(MINIMAX_CN_BASE_URL);
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
    mockCreateImpl = () =>
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
      );
    const model = new MiniMaxModel("MiniMax-M3", { reasoningSplit: false });
    const events: StreamEvent[] = [];
    for await (const e of model.generate([{ role: "user", content: "hi" }])) events.push(e);
    const thinking = events.filter((e) => e.type === "thinking_delta");
    expect(thinking[0]?.delta).toBe("inner reasoning");
    const text = events.filter((e) => e.type === "text_delta");
    expect(text.some((e) => e.delta?.includes("answer"))).toBe(true);
    expect(text.every((e) => !e.delta?.includes("<think>") && !e.delta?.includes("</think>"))).toBe(
      true
    );
  });

  it("reasoning_split=false: <think> split across chunks handled correctly", async () => {
    mockCreateImpl = () =>
      Promise.resolve(
        makeChunkStream([
          { choices: [{ delta: { content: "<thi" }, finish_reason: null }] },
          {
            choices: [
              { delta: { content: "nk>thinking text</think>done" }, finish_reason: "stop" },
            ],
          },
        ])
      );
    const model = new MiniMaxModel("MiniMax-M3", { reasoningSplit: false });
    const events: StreamEvent[] = [];
    for await (const e of model.generate([{ role: "user", content: "hi" }])) events.push(e);
    const thinking = events.filter((e) => e.type === "thinking_delta");
    expect(thinking.map((e) => e.delta).join("")).toBe("thinking text");
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => e.delta)
      .join("");
    expect(text).toContain("done");
  });

  it("getModelMeta for MiniMax-M2.7 shows isReasoning:true", async () => {
    expect(getModelMeta("MiniMax-M2.7").isReasoning).toBe(true);
  });

  // ── Model constants ──────────────────────────────────────────────────────

  it("MiniMaxModels.LATEST is defined as MiniMax-M3", async () => {
    expect(typeof MiniMaxModels.LATEST).toBe("string");
    expect(MiniMaxModels.LATEST).toBe("MiniMax-M3");
  });
});
