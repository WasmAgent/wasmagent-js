import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { StreamEvent } from "@wasmagent/core/models";

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
      return {
        async next() {
          if (i < chunks.length) return { value: chunks[i++] as OAIChunk, done: false };
          return { value: undefined as unknown as OAIChunk, done: true };
        },
      };
    },
  };
}

// Shared mutable mock state
let mockCreateImpl: ((params: Record<string, unknown>) => unknown) | null = null;
let mockConstructorImpl: ((opts: Record<string, unknown>) => unknown) | null = null;

mock.module("openai", () => {
  return {
    default: class MockOpenAI {
      constructor(opts: Record<string, unknown>) {
        if (mockConstructorImpl) {
          const result = mockConstructorImpl(opts);
          Object.assign(this as Record<string, unknown>, result as Record<string, unknown>);
          return;
        }
        (this as Record<string, unknown>).chat = {
          completions: {
            create: mock((params: Record<string, unknown>) => {
              if (mockCreateImpl) return mockCreateImpl(params);
              return Promise.resolve(makeChunkStream([]));
            }),
          },
        };
      }
    },
  };
});

import { QWEN_BASE_URL, QWEN_INTL_BASE_URL, QwenModel, QwenModels } from "./qwen.js";

async function collectEvents(
  chunks: OAIChunk[],
  modelId = "qwen3-max",
  opts: Parameters<QwenModel["generate"]>[1] = {},
  captureParams?: { ref: Record<string, unknown> | null }
): Promise<StreamEvent[]> {
  mockCreateImpl = (params: Record<string, unknown>) => {
    if (captureParams) captureParams.ref = params;
    return Promise.resolve(makeChunkStream(chunks));
  };
  mockConstructorImpl = null;
  const model = new QwenModel(modelId, "key");
  const events: StreamEvent[] = [];
  for await (const e of model.generate([{ role: "user", content: "x" }], opts)) events.push(e);
  return events;
}

describe("QwenModel", () => {
  beforeEach(() => {
    mockCreateImpl = null;
    mockConstructorImpl = null;
  });

  it("emits text_delta for content", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] },
    ]);
    expect(events.filter((e) => e.type === "text_delta")[0]?.delta).toBe("hi");
  });

  it("emits thinking_delta for qwen3-max", async () => {
    const events = await collectEvents(
      [
        { choices: [{ delta: { reasoning_content: "reasoning" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ],
      "qwen3-max"
    );
    expect(events.filter((e) => e.type === "thinking_delta")[0]?.delta).toBe("reasoning");
  });

  it("does NOT emit thinking_delta for qwen2.5-*", async () => {
    const events = await collectEvents(
      [{ choices: [{ delta: { reasoning_content: "skip" }, finish_reason: "stop" }] }],
      "qwen2.5-72b-instruct"
    );
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
  });

  // ── L9-1: Thinking params ────────────────────────────────────────────────

  it("default qwen3: sends enable_thinking:true", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "qwen3-max",
      {},
      captured
    );
    expect(captured.ref?.enable_thinking).toBe(true);
  });

  it("mode:off sends enable_thinking:false", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "qwen3-max",
      { thinking: { mode: "off" } },
      captured
    );
    expect(captured.ref?.enable_thinking).toBe(false);
  });

  it("mode:off suppresses thinking_delta", async () => {
    const events = await collectEvents(
      [
        { choices: [{ delta: { reasoning_content: "hidden" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ],
      "qwen3-max",
      { thinking: { mode: "off" } }
    );
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
    expect(typeof captured.ref?.thinking_budget).toBe("number");
    expect((captured.ref?.thinking_budget as number) > 0).toBe(true);
  });

  it("explicit budgetTokens overrides effort budget", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "qwen3-max",
      { thinking: { mode: "enabled", budgetTokens: 8000 } },
      captured
    );
    expect(captured.ref?.thinking_budget).toBe(8000);
  });

  // ── L9-2: Region ─────────────────────────────────────────────────────────

  it("region:intl uses intl base URL", async () => {
    let capturedBase: string | undefined;
    mockConstructorImpl = (opts: Record<string, unknown>) => {
      capturedBase = opts.baseURL as string;
      return {
        chat: {
          completions: {
            create: mock().mockResolvedValue(
              makeChunkStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }])
            ),
          },
        },
      };
    };
    const model = new QwenModel("qwen3-max", { region: "intl" });
    for await (const _ of model.generate([{ role: "user", content: "hi" }])) {
      /* consume */
    }
    expect(capturedBase).toBe(QWEN_INTL_BASE_URL);
  });

  it("default region uses CN base URL", async () => {
    let capturedBase: string | undefined;
    mockConstructorImpl = (opts: Record<string, unknown>) => {
      capturedBase = opts.baseURL as string;
      return {
        chat: {
          completions: {
            create: mock().mockResolvedValue(
              makeChunkStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }])
            ),
          },
        },
      };
    };
    const model = new QwenModel("qwen3-max", "key");
    for await (const _ of model.generate([{ role: "user", content: "hi" }])) {
      /* consume */
    }
    expect(capturedBase).toBe(QWEN_BASE_URL);
  });

  it("QwenModels.LATEST is defined", async () => {
    expect(typeof QwenModels.LATEST).toBe("string");
  });
});
