import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ModelMessage, StreamEvent } from "../models/types.js";

/**
 * OpenAIModel tests — mock the `openai` dynamic import so no network calls.
 *
 * The model lazily imports `openai` inside generate(), so we intercept via
 * mock.module() at the module level and replace the OpenAI constructor with a
 * stub that yields controlled chunks.
 */

type OAIChunk = {
  choices: Array<{
    delta: {
      content?: string | null;
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

// ── Shared mutable mock state ─────────────────────────────────────────────────
// Each test sets mockCreateImpl before calling the model.
let mockCreateImpl: ((...args: unknown[]) => unknown) | null = null;

mock.module("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mock((...args: unknown[]) => mockCreateImpl?.(...args)),
        },
      };
      // No `responses` property — forces fallback in the Responses API path tests.
    },
  };
});

import { OpenAIModel } from "../models/OpenAIModel.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeChunkStream(chunks: OAIChunk[]): AsyncIterable<OAIChunk> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length) {
            return { value: chunks[i++] as OAIChunk, done: false };
          }
          return { value: undefined as unknown as OAIChunk, done: true };
        },
      };
    },
  };
}

/**
 * Capture all StreamEvents emitted by a fresh OpenAIModel for the given chunks.
 * Sets mockCreateImpl before each invocation so the mock returns the right data.
 */
async function collectEvents(
  chunks: OAIChunk[],
  opts: { tools?: object[] } = {}
): Promise<StreamEvent[]> {
  mockCreateImpl = () => Promise.resolve(makeChunkStream(chunks));

  const model = new OpenAIModel("gpt-4o", "test-key");
  const events: StreamEvent[] = [];
  for await (const e of model.generate([{ role: "user", content: "test" }], opts)) {
    events.push(e);
  }
  return events;
}

/**
 * Call generate() with the given messages and return the raw params object
 * that was passed to chat.completions.create().
 */
async function generateWithMessages(messages: ModelMessage[]): Promise<Record<string, unknown>> {
  let capturedArgs: unknown;
  mockCreateImpl = (...args: unknown[]) => {
    capturedArgs = args[0];
    return Promise.resolve(makeChunkStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }]));
  };

  const model = new OpenAIModel("gpt-4o", "key");
  for await (const _ of model.generate(messages)) {
    /* consume */
  }
  return capturedArgs as Record<string, unknown>;
}

/**
 * Instantiate a model with the given modelId, run generate(), and return the
 * params passed to chat.completions.create().
 */
async function getParams(modelId: string): Promise<Record<string, unknown>> {
  let capturedArgs: unknown;
  mockCreateImpl = (...args: unknown[]) => {
    capturedArgs = args[0];
    return Promise.resolve(makeChunkStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }]));
  };

  const model = new OpenAIModel(modelId, "key");
  for await (const _ of model.generate([{ role: "user", content: "hi" }])) {
    /* consume */
  }
  return capturedArgs as Record<string, unknown>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("OpenAIModel streaming", () => {
  beforeEach(() => {
    mockCreateImpl = null;
  });

  it("emits text_delta events for content chunks", async () => {
    const chunks: OAIChunk[] = [
      { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
      { choices: [{ delta: { content: " world" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    const events = await collectEvents(chunks);
    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents.map((e) => e.delta)).toEqual(["Hello", " world"]);
  });

  it("emits stop event with stopReason 'end_turn' on finish_reason=stop", async () => {
    const chunks: OAIChunk[] = [
      { choices: [{ delta: { content: "done" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    const events = await collectEvents(chunks);
    const stopEvent = events.find((e) => e.type === "stop");
    expect(stopEvent?.stopReason).toBe("end_turn");
  });

  it("emits usage event when chunk.usage is present", async () => {
    const chunks: OAIChunk[] = [
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    ];
    const events = await collectEvents(chunks);
    const usageEvent = events.find((e) => e.type === "usage");
    expect(usageEvent?.usage?.inputTokens).toBe(10);
    expect(usageEvent?.usage?.outputTokens).toBe(5);
  });

  it("accumulates tool_call deltas across multiple chunks and emits one tool_call event", async () => {
    const chunks: OAIChunk[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call-1", function: { name: "search", arguments: "" } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"q' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: 'uery":"AI"}' } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const events = await collectEvents(chunks);
    const toolCallEvents = events.filter((e) => e.type === "tool_call");
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]?.toolCall?.name).toBe("search");
    expect(toolCallEvents[0]?.toolCall?.input).toEqual({ query: "AI" });
    expect(toolCallEvents[0]?.toolCall?.id).toBe("call-1");
  });

  it("emits stop with stopReason 'tool_use' on finish_reason=tool_calls", async () => {
    const chunks: OAIChunk[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "fn", arguments: "{}" } }],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const events = await collectEvents(chunks);
    const stopEvent = events.find((e) => e.type === "stop");
    expect(stopEvent?.stopReason).toBe("tool_use");
  });

  it("no text_delta events when only tool_calls are produced", async () => {
    const chunks: OAIChunk[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "fn", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ];
    const events = await collectEvents(chunks);
    expect(events.filter((e) => e.type === "text_delta")).toHaveLength(0);
  });
});

/**
 * OpenAIModel message conversion tests — test convertMessages indirectly
 * through MessageAssembler producing ModelMessage[] with structured blocks.
 */
import { MessageAssembler } from "../memory/MessageAssembler.js";

describe("OpenAIModel convertMessages (via MessageAssembler)", () => {
  it("system message content is passed as string", () => {
    const assembler = new MessageAssembler({ systemPrompt: "You are helpful.", toolsSchema: [] });
    const messages = assembler.build();
    const sys = messages.find((m) => m.role === "system");
    expect(typeof sys?.content).toBe("string");
    expect(sys?.content as string).toContain("You are helpful.");
  });

  it("tool_use block in assistant message has id, name, input fields", () => {
    const assembler = new MessageAssembler({ systemPrompt: "p", toolsSchema: [] });
    assembler.addStep({
      type: "tool_use",
      stepIndex: 1,
      thoughts: "",
      toolCallId: "tc1",
      toolName: "calc",
      toolInput: { expr: "2+2" },
      toolOutput: "4",
      isError: false,
    });
    const messages = assembler.build();
    const assistantBlocks = messages[1]?.content as unknown as Array<Record<string, unknown>>;
    const toolUse = assistantBlocks.find((b) => b.type === "tool_use");
    expect(toolUse?.id).toBe("tc1");
    expect(toolUse?.name).toBe("calc");
    expect((toolUse?.input as Record<string, unknown>).expr).toBe("2+2");
  });

  it("tool_result block in user message has toolUseId and content fields", () => {
    const assembler = new MessageAssembler({ systemPrompt: "p", toolsSchema: [] });
    assembler.addStep({
      type: "tool_use",
      stepIndex: 1,
      thoughts: "",
      toolCallId: "tc2",
      toolName: "search",
      toolInput: {},
      toolOutput: "found it",
      isError: false,
    });
    const messages = assembler.build();
    const userBlocks = messages[2]?.content as unknown as Array<Record<string, unknown>>;
    const result = userBlocks.find((b) => b.type === "tool_result");
    expect(result?.toolUseId).toBe("tc2");
    expect(result?.content).toBe("found it");
  });

  it("assistant message with only tool_use (no text) has no text block", () => {
    const assembler = new MessageAssembler({ systemPrompt: "p", toolsSchema: [] });
    assembler.addStep({
      type: "tool_use",
      stepIndex: 1,
      thoughts: "",
      toolCallId: "tc3",
      toolName: "fn",
      toolInput: {},
      toolOutput: "ok",
      isError: false,
    });
    const messages = assembler.build();
    const assistantBlocks = messages[1]?.content as unknown as Array<Record<string, unknown>>;
    expect(assistantBlocks.every((b) => b.type !== "text")).toBe(true);
  });
});

/**
 * Tests that exercise OpenAIModel.convertMessages() paths by calling generate()
 * with structured ModelMessage content (tool_use, tool_result, text arrays).
 */
describe("OpenAIModel generate() with structured content messages", () => {
  beforeEach(() => {
    mockCreateImpl = null;
  });

  it("system message is converted to role:system with string content", async () => {
    const params = await generateWithMessages([
      { role: "system", content: "Be helpful." },
      { role: "user", content: "hi" },
    ]);
    const msgs = params.messages as Array<Record<string, unknown>>;
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[0]?.content).toBe("Be helpful.");
  });

  it("assistant message with tool_use block is converted to tool_calls format", async () => {
    const params = await generateWithMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me search" },
          { type: "tool_use", id: "c1", name: "search", input: { q: "AI" } },
        ],
      },
    ]);
    const msgs = params.messages as Array<Record<string, unknown>>;
    const assistantMsg = msgs[0] as Record<string, unknown>;
    expect(assistantMsg?.role).toBe("assistant");
    expect(Array.isArray(assistantMsg?.tool_calls)).toBe(true);
    const toolCalls = assistantMsg?.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls[0]?.id).toBe("c1");
  });

  it("user message with tool_result block is converted to role:tool", async () => {
    const params = await generateWithMessages([
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "c1", content: "result text" }],
      },
    ]);
    const msgs = params.messages as Array<Record<string, unknown>>;
    expect(msgs[0]?.role).toBe("tool");
    expect(msgs[0]?.content).toBe("result text");
    expect(msgs[0]?.tool_call_id).toBe("c1");
  });

  it("user message with text blocks is combined and converted", async () => {
    const params = await generateWithMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: " world" },
        ],
      },
    ]);
    const msgs = params.messages as Array<Record<string, unknown>>;
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.content).toBe("hello\n world");
  });
});

// D1: reasoning model detection tests
describe("OpenAIModel D1 reasoning-model params", () => {
  beforeEach(() => {
    mockCreateImpl = null;
  });

  it("D1: standard model uses max_tokens and no max_completion_tokens", async () => {
    const params = await getParams("gpt-4o");
    expect(params.max_tokens).toBeDefined();
    expect(params.max_completion_tokens).toBeUndefined();
  });

  it("D1: o3 model uses max_completion_tokens and no max_tokens", async () => {
    const params = await getParams("o3");
    expect(params.max_completion_tokens).toBeDefined();
    expect(params.max_tokens).toBeUndefined();
  });

  it("D1: o4-mini model uses max_completion_tokens", async () => {
    const params = await getParams("o4-mini");
    expect(params.max_completion_tokens).toBeDefined();
    expect(params.max_tokens).toBeUndefined();
  });

  it("D1: temperature is not set for o-series models", async () => {
    let capturedArgs: unknown;
    mockCreateImpl = (...args: unknown[]) => {
      capturedArgs = args[0];
      return Promise.resolve(
        makeChunkStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }])
      );
    };

    const model = new OpenAIModel("o3", { apiKey: "key", samplingParams: { temperature: 0.7 } });
    for await (const _ of model.generate([{ role: "user", content: "hi" }])) {
      /* consume */
    }
    const params = capturedArgs as Record<string, unknown>;
    expect(params.temperature).toBeUndefined();
  });
});

// ── D2: OpenAI cached_tokens metering ────────────────────────────────────────

describe("OpenAIModel D2 — prompt_tokens_details.cached_tokens", () => {
  beforeEach(() => {
    mockCreateImpl = null;
  });

  it("reads cached_tokens from prompt_tokens_details and maps to cacheReadTokens", async () => {
    const chunk: OAIChunk = {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 50,
        // @ts-expect-error — OpenAI SDK type may not include this yet
        prompt_tokens_details: { cached_tokens: 150 },
      },
    };
    mockCreateImpl = () => Promise.resolve(makeChunkStream([chunk]));

    const model = new OpenAIModel("gpt-4o", "key");
    const events: StreamEvent[] = [];
    for await (const ev of model.generate([{ role: "user", content: "hi" }])) {
      events.push(ev);
    }
    const usageEv = events.find((e) => e.type === "usage");
    expect(usageEv?.usage?.cacheReadTokens).toBe(150);
  });

  it("does not set cacheReadTokens when cached_tokens is 0", async () => {
    const chunk: OAIChunk = {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 50,
        // @ts-expect-error
        prompt_tokens_details: { cached_tokens: 0 },
      },
    };
    mockCreateImpl = () => Promise.resolve(makeChunkStream([chunk]));

    const model = new OpenAIModel("gpt-4o", "key");
    const events: StreamEvent[] = [];
    for await (const ev of model.generate([{ role: "user", content: "hi" }])) {
      events.push(ev);
    }
    const usageEv = events.find((e) => e.type === "usage");
    expect(usageEv?.usage?.cacheReadTokens).toBeUndefined();
  });

  it("does not set cacheReadTokens when prompt_tokens_details is absent", async () => {
    const chunk: OAIChunk = {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    };
    mockCreateImpl = () => Promise.resolve(makeChunkStream([chunk]));

    const model = new OpenAIModel("gpt-4o", "key");
    const events: StreamEvent[] = [];
    for await (const ev of model.generate([{ role: "user", content: "hi" }])) {
      events.push(ev);
    }
    const usageEv = events.find((e) => e.type === "usage");
    expect(usageEv?.usage?.cacheReadTokens).toBeUndefined();
  });
});

describe("OpenAIModel apiMode", () => {
  it("defaults to 'responses' when no baseURL", () => {
    const model = new OpenAIModel("gpt-4o", "key");
    expect(model.apiMode).toBe("responses");
  });

  it("defaults to 'chat' when baseURL is set", () => {
    const model = new OpenAIModel("gpt-4o", { baseURL: "http://localhost:11434/v1" });
    expect(model.apiMode).toBe("chat");
  });

  it("explicit apiMode='chat' overrides auto-detection", () => {
    const model = new OpenAIModel("gpt-4o", { apiMode: "chat" });
    expect(model.apiMode).toBe("chat");
  });

  it("explicit apiMode='responses' works with baseURL", () => {
    const model = new OpenAIModel("gpt-4o", {
      baseURL: "https://oai-proxy.example.com",
      apiMode: "responses",
    });
    expect(model.apiMode).toBe("responses");
  });

  it("Responses API path falls back to chat when responses.create absent", async () => {
    // The module-level mock has no `responses` property, so the model
    // will fall back to chat.completions.create automatically.
    mockCreateImpl = () =>
      Promise.resolve(
        makeChunkStream([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }])
      );

    const model = new OpenAIModel("gpt-4o", "key"); // apiMode="responses" by default
    const events: StreamEvent[] = [];
    for await (const ev of model.generate([{ role: "user", content: "hello" }])) {
      events.push(ev);
    }
    // Falls back to chat completions — should produce text_delta.
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
  });
});
