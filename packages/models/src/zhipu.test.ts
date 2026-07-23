import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { StreamEvent } from "@wasmagent/core/models";

type OAIChunk = {
  choices: Array<{
    delta: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
};

// Shared mutable mock state — mutated per-test before calling generate()
let mockCreateImpl: ((params: Record<string, unknown>) => Promise<AsyncIterable<OAIChunk>>) | null =
  null;

mock.module("openai", () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: mock((params: Record<string, unknown>) => mockCreateImpl?.(params)),
      },
    };
  },
}));

// Import after mock.module so the mock is in place
import { GLMModels, ZhipuModel } from "./zhipu.js";

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
  modelId = "glm-5",
  opts: Parameters<ZhipuModel["generate"]>[1] = {},
  captureParams?: { ref: Record<string, unknown> | null }
): Promise<StreamEvent[]> {
  mockCreateImpl = (params: Record<string, unknown>) => {
    if (captureParams) captureParams.ref = params;
    return Promise.resolve(makeChunkStream(chunks));
  };
  const model = new ZhipuModel(modelId, "key");
  const events: StreamEvent[] = [];
  for await (const e of model.generate([{ role: "user", content: "x" }], opts)) events.push(e);
  return events;
}

describe("ZhipuModel", () => {
  beforeEach(() => {
    mockCreateImpl = null;
  });

  it("emits text_delta for content", async () => {
    const events = await collectEvents([
      { choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    expect(events.filter((e) => e.type === "text_delta")[0]?.delta).toBe("Hi");
  });

  it("emits thinking_delta for reasoning_content on glm-5", async () => {
    const events = await collectEvents(
      [
        { choices: [{ delta: { reasoning_content: "thinking..." }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ],
      "glm-5"
    );
    expect(events.filter((e) => e.type === "thinking_delta")[0]?.delta).toBe("thinking...");
  });

  it("emits thinking_delta for reasoning_content on glm-4.7 (hybrid model)", async () => {
    const events = await collectEvents(
      [
        { choices: [{ delta: { reasoning_content: "thinking..." }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ],
      "glm-4.7"
    );
    expect(events.filter((e) => e.type === "thinking_delta")[0]?.delta).toBe("thinking...");
  });

  it("does NOT emit thinking_delta for glm-4-plus (non-reasoning model)", async () => {
    const events = await collectEvents(
      [
        { choices: [{ delta: { reasoning_content: "ignored" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ],
      "glm-4-plus"
    );
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
  });

  // ── L10-1: thinking:{type} via extra_body ───────────────────────────────

  it("glm-5 default: sends thinking:{type:enabled} in extra_body", async () => {
    const captured = { ref: null as Record<string, unknown> | null };
    await collectEvents(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      "glm-5",
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
      "glm-5",
      { thinking: { mode: "off" } },
      captured
    );
    const body = captured.ref?.extra_body as Record<string, unknown> | undefined;
    expect(body?.thinking).toMatchObject({ type: "disabled" });
  });

  it("mode:off suppresses thinking_delta even on glm-5", async () => {
    const events = await collectEvents(
      [
        { choices: [{ delta: { reasoning_content: "hidden" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ],
      "glm-5",
      { thinking: { mode: "off" } }
    );
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
  });

  // ── L10-2: Model constants ───────────────────────────────────────────────

  it("GLMModels.LATEST is defined and points to glm-5", () => {
    expect(typeof GLMModels.LATEST).toBe("string");
    expect(GLMModels.LATEST).toBe("glm-5");
  });
});
