import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModelMessage, StreamEvent } from "@agentkit-js/core/models";

// ── Mock helpers ──────────────────────────────────────────────────────────────

type AnthropicEvent =
  | { type: "content_block_delta"; delta: { type: "text_delta"; text: string } }
  | { type: "message_delta"; usage: { output_tokens: number } }
  | { type: "message_stop" };

interface FinalMessage {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

function makeStream(events: AnthropicEvent[], finalMsg: FinalMessage) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < events.length) return { value: events[i++]!, done: false };
          return { value: undefined as unknown as AnthropicEvent, done: true };
        },
      };
    },
    async finalMessage() {
      return finalMsg;
    },
  };
}

function makeAnthropicMock(events: AnthropicEvent[], finalMsg: FinalMessage) {
  const mockStream = vi.fn().mockReturnValue(makeStream(events, finalMsg));
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: { stream: mockStream },
  }));
  return { MockAnthropic, mockStream };
}

async function collectEvents(
  events: AnthropicEvent[],
  finalMsg: FinalMessage,
  messages: ModelMessage[] = [{ role: "user", content: "test" }],
  modelId = "claude-sonnet-4-6"
): Promise<{ streamEvents: StreamEvent[]; mockStream: ReturnType<typeof vi.fn> }> {
  const { MockAnthropic, mockStream } = makeAnthropicMock(events, finalMsg);
  vi.doMock("@anthropic-ai/sdk", () => ({ default: MockAnthropic }));

  // Import from the package index (re-export of core) — validates the re-export chain.
  const { AnthropicModel } = await import("./index.js?t=" + Date.now());
  const model = new AnthropicModel(modelId, "test-key");

  const streamEvents: StreamEvent[] = [];
  for await (const e of model.generate(messages)) {
    streamEvents.push(e);
  }
  vi.doUnmock("@anthropic-ai/sdk");
  return { streamEvents, mockStream };
}

const EMPTY_FINAL: FinalMessage = {
  content: [],
  usage: { input_tokens: 10, output_tokens: 5 },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AnthropicModel generate() (via @agentkit-js/model-anthropic re-export)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("emits text_delta events from content_block_delta", async () => {
    const { streamEvents } = await collectEvents(
      [
        { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: " world" } },
        { type: "message_stop" },
      ],
      EMPTY_FINAL
    );
    const textEvents = streamEvents.filter((e) => e.type === "text_delta");
    expect(textEvents.map((e) => e.delta)).toEqual(["Hello", " world"]);
  });

  it("emits stop event on message_stop", async () => {
    const { streamEvents } = await collectEvents([{ type: "message_stop" }], EMPTY_FINAL);
    const stop = streamEvents.find((e) => e.type === "stop");
    expect(stop?.stopReason).toBe("end_turn");
  });

  it("emits usage event from message_delta", async () => {
    const { streamEvents } = await collectEvents(
      [{ type: "message_delta", usage: { output_tokens: 12 } }],
      EMPTY_FINAL
    );
    const usage = streamEvents.find((e) => e.type === "usage");
    expect(usage?.usage?.outputTokens).toBe(12);
  });

  it("emits final usage event from finalMessage.usage", async () => {
    const finalMsg: FinalMessage = {
      content: [],
      usage: { input_tokens: 20, output_tokens: 8 },
    };
    const { streamEvents } = await collectEvents([], finalMsg);
    const usageEvents = streamEvents.filter((e) => e.type === "usage");
    const last = usageEvents[usageEvents.length - 1];
    expect(last?.usage?.inputTokens).toBe(20);
    expect(last?.usage?.outputTokens).toBe(8);
  });

  it("emits cacheReadTokens and cacheWriteTokens when present (B1)", async () => {
    const finalMsg: FinalMessage = {
      content: [],
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    };
    const { streamEvents } = await collectEvents([], finalMsg);
    const usageEvents = streamEvents.filter((e) => e.type === "usage");
    const last = usageEvents[usageEvents.length - 1];
    expect(last?.usage?.cacheReadTokens).toBe(80);
    expect(last?.usage?.cacheWriteTokens).toBe(20);
  });

  it("emits tool_call events from finalMessage.content tool_use blocks", async () => {
    const finalMsg: FinalMessage = {
      content: [
        { type: "tool_use", id: "tu-1", name: "search", input: { query: "TypeScript" } },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const { streamEvents } = await collectEvents([], finalMsg);
    const toolCalls = streamEvents.filter((e) => e.type === "tool_call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolCall?.name).toBe("search");
    expect(toolCalls[0]?.toolCall?.id).toBe("tu-1");
    expect(toolCalls[0]?.toolCall?.input).toEqual({ query: "TypeScript" });
  });

  it("passes temperature/topP/stopSequences through to the SDK (no sampling drift)", async () => {
    const { MockAnthropic, mockStream } = makeAnthropicMock([], EMPTY_FINAL);
    vi.doMock("@anthropic-ai/sdk", () => ({ default: MockAnthropic }));
    const { AnthropicModel } = await import("./index.js?t=" + Date.now() + "sp");
    const model = new AnthropicModel("claude-sonnet-4-6", "key");
    for await (const _ of model.generate(
      [{ role: "user", content: "hi" }],
      { temperature: 0.7, topP: 0.9, stopSequences: ["STOP"] }
    )) { /* consume */ }
    const call = mockStream.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call?.["temperature"]).toBe(0.7);
    expect(call?.["top_p"]).toBe(0.9);
    expect(call?.["stop_sequences"]).toEqual(["STOP"]);
    vi.doUnmock("@anthropic-ai/sdk");
  });

  it("does NOT inject cache_control when system message is below token threshold", async () => {
    const shortPrompt = "Be helpful.";
    const { MockAnthropic, mockStream } = makeAnthropicMock([], EMPTY_FINAL);
    vi.doMock("@anthropic-ai/sdk", () => ({ default: MockAnthropic }));
    const { AnthropicModel } = await import("./index.js?t=" + Date.now() + "3");
    const model = new AnthropicModel("claude-sonnet-4-6", "key");
    for await (const _ of model.generate([
      { role: "system", content: shortPrompt },
      { role: "user", content: "hi" },
    ])) { /* consume */ }
    const call = mockStream.mock.calls[0]?.[0] as Record<string, unknown>;
    const systemParam = call?.["system"] as Array<Record<string, unknown>>;
    expect(systemParam[0]?.["cache_control"]).toBeUndefined();
    vi.doUnmock("@anthropic-ai/sdk");
  });
});
