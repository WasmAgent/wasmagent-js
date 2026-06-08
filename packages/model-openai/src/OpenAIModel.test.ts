import type { ModelMessage, StreamEvent } from "@agentkit-js/core/models";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OpenAIModel tests — mock the `openai` dynamic import so no network calls.
 *
 * The model lazily imports `openai` inside generate(), so we intercept via
 * vi.mock at the module level and replace the OpenAI constructor with a stub
 * that yields controlled chunks.
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

function makeChunkStream(chunks: OAIChunk[]): AsyncIterable<OAIChunk> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length) {
            return { value: chunks[i++]!, done: false };
          }
          return { value: undefined as unknown as OAIChunk, done: true };
        },
      };
    },
  };
}

function makeOpenAIMock(chunks: OAIChunk[]) {
  const mockCreate = vi.fn().mockResolvedValue(makeChunkStream(chunks));
  const MockOpenAI = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
  return { MockOpenAI, mockCreate };
}

async function collectEvents(
  chunks: OAIChunk[],
  opts: { tools?: object[] } = {}
): Promise<StreamEvent[]> {
  const { MockOpenAI } = makeOpenAIMock(chunks);

  vi.doMock("openai", () => ({ default: MockOpenAI }));

  // Re-import after mocking to get a fresh module.
  const { OpenAIModel } = await import("./index.js?t=" + Date.now() + "");
  const model = new OpenAIModel("gpt-4o", "test-key");

  const events: StreamEvent[] = [];
  for await (const e of model.generate([{ role: "user", content: "test" }], opts)) {
    events.push(e);
  }
  vi.doUnmock("openai");
  return events;
}

describe("OpenAIModel streaming", () => {
  beforeEach(() => {
    vi.resetModules();
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
import { MessageAssembler } from "@agentkit-js/core";

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
    vi.resetModules();
  });

  async function generateWithMessages(messages: ModelMessage[]): Promise<Record<string, unknown>> {
    const { MockOpenAI, mockCreate } = makeOpenAIMock([
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    vi.doMock("openai", () => ({ default: MockOpenAI }));
    const { OpenAIModel } = await import("./index.js?t=" + Date.now() + "s");
    const model = new OpenAIModel("gpt-4o", "key");
    for await (const _ of model.generate(messages)) {
      /* consume */
    }
    vi.doUnmock("openai");
    return mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
  }

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

/**
 * S1: response_format / structured output tests.
 */
describe("OpenAIModel generate() responseFormat (S1)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function generateWithOpts(opts: object): Promise<Record<string, unknown>> {
    const { MockOpenAI, mockCreate } = makeOpenAIMock([
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    vi.doMock("openai", () => ({ default: MockOpenAI }));
    const { OpenAIModel } = await import("./index.js?t=" + Date.now() + "rf");
    const model = new OpenAIModel("gpt-4o", "key"); // supportsGrammar=true
    for await (const _ of model.generate([{ role: "user", content: "q" }], opts)) {
      /* consume */
    }
    vi.doUnmock("openai");
    return mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  it("sends response_format json_object when responseFormat.type is json_object", async () => {
    const params = await generateWithOpts({ responseFormat: { type: "json_object" } });
    expect((params.response_format as Record<string, unknown>)?.type).toBe("json_object");
  });

  it("sends response_format json_schema with schema and name", async () => {
    const params = await generateWithOpts({
      responseFormat: {
        type: "json_schema",
        name: "my_schema",
        schema: { type: "object", properties: { value: { type: "number" } } },
        strict: true,
      },
    });
    const rf = params.response_format as Record<string, unknown>;
    expect(rf?.type).toBe("json_schema");
    const js = rf?.json_schema as Record<string, unknown>;
    expect(js?.name).toBe("my_schema");
    expect((js?.schema as Record<string, unknown>)?.type).toBe("object");
    expect(js?.strict).toBe(true);
  });

  it("uses default name 'response' when name is omitted", async () => {
    const params = await generateWithOpts({
      responseFormat: { type: "json_schema", schema: { type: "object" } },
    });
    const js = (params.response_format as Record<string, unknown>)?.json_schema as Record<
      string,
      unknown
    >;
    expect(js?.name).toBe("response");
  });

  it("does NOT send response_format when responseFormat is absent", async () => {
    const params = await generateWithOpts({});
    expect(params.response_format).toBeUndefined();
  });
});

// ── A2: Reasoning effort + verbosity (Chat API) ───────────────────────────────

describe("OpenAIModel — reasoning effort (A2)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function generateAndCapture(
    modelId: string,
    opts: object,
    samplingParams?: object
  ): Promise<Record<string, unknown>> {
    const { MockOpenAI, mockCreate } = makeOpenAIMock([
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    vi.doMock("openai", () => ({ default: MockOpenAI }));
    const { OpenAIModel } = await import("./index.js?t=" + Date.now() + "eff");
    const model = new OpenAIModel(
      modelId,
      samplingParams
        ? { apiKey: "key", samplingParams: samplingParams as Record<string, unknown> }
        : "key"
    );
    for await (const _ of model.generate([{ role: "user", content: "hi" }], opts)) {
      /* consume */
    }
    vi.doUnmock("openai");
    return mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  it("sends reasoning_effort=medium for effort:'standard' (o3)", async () => {
    const params = await generateAndCapture("o3", {
      thinking: { mode: "adaptive", effort: "standard" },
    });
    expect(params.reasoning_effort).toBe("medium");
  });

  it("sends reasoning_effort=xhigh for effort:'max'", async () => {
    const params = await generateAndCapture("o3", {
      thinking: { mode: "adaptive", effort: "max" },
    });
    expect(params.reasoning_effort).toBe("xhigh");
  });

  it("sends reasoning_effort=none for effort:'none'", async () => {
    const params = await generateAndCapture("o3", {
      thinking: { mode: "adaptive", effort: "none" },
    });
    expect(params.reasoning_effort).toBe("none");
  });

  it("samplingParams.reasoningEffort is used when thinking opts absent", async () => {
    const params = await generateAndCapture("o4-mini", {}, { reasoningEffort: "high" });
    expect(params.reasoning_effort).toBe("high");
  });

  it("thinking opts effort overrides samplingParams.reasoningEffort", async () => {
    const params = await generateAndCapture(
      "o3",
      { thinking: { mode: "adaptive", effort: "xhigh" } },
      { reasoningEffort: "low" }
    );
    expect(params.reasoning_effort).toBe("xhigh");
  });
});

// ── A4: Model enums and capabilities ─────────────────────────────────────────

describe("OpenAIModel — model registry + capabilities (A4)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("OpenAIModels.LATEST points to gpt-5.5", async () => {
    vi.doMock("openai", () => ({ default: vi.fn() }));
    const { OpenAIModels } = await import("./index.js?t=" + Date.now() + "en1");
    expect(OpenAIModels.LATEST).toBe("gpt-5.5");
    vi.doUnmock("openai");
  });

  it("gpt-5 model has supportsVerbosity=true", async () => {
    vi.doMock("openai", () => ({ default: vi.fn() }));
    const { OpenAIModel } = await import("./index.js?t=" + Date.now() + "en2");
    const model = new OpenAIModel("gpt-5", "key");
    expect(model.capabilities.supportsVerbosity).toBe(true);
    vi.doUnmock("openai");
  });

  it("o3 model has supportsReasoningEffort=true", async () => {
    vi.doMock("openai", () => ({ default: vi.fn() }));
    const { OpenAIModel } = await import("./index.js?t=" + Date.now() + "en3");
    const model = new OpenAIModel("o3", "key");
    expect(model.capabilities.supportsReasoningEffort).toBe(true);
    vi.doUnmock("openai");
  });

  it("gpt-4o model has supportsVerbosity=false (legacy)", async () => {
    vi.doMock("openai", () => ({ default: vi.fn() }));
    const { OpenAIModel } = await import("./index.js?t=" + Date.now() + "en4");
    const model = new OpenAIModel("gpt-4o", "key");
    expect(model.capabilities.supportsVerbosity).toBe(false);
    vi.doUnmock("openai");
  });
});
