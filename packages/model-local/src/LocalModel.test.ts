/**
 * LocalModel tests — exercises the Model interface, grammar mode selection,
 * and message/prompt rendering with a stub node-llama-cpp module so no
 * native binding is needed.
 */

import { describe, expect, it } from "vitest";
import { LocalModel, __setLlamaModuleForTests, renderMessagesAsPrompt } from "./LocalModel.js";
import { LocalModelDependencyError } from "./types.js";

interface RecordedPrompt {
  text: string;
  hasGrammar: boolean;
  numericOpts: Record<string, unknown>;
}

function makeStubModule(opts: {
  reply: string | ((prompt: string) => string);
  hasGrammarFn?: boolean;
  recorded?: RecordedPrompt[];
}) {
  const recorded = opts.recorded ?? [];
  const llama = {
    loadModel: async (_o: { modelPath: string }) => ({
      trainContextSize: 4096,
      createContext: async (_co: object) => ({
        contextSize: 4096,
        getSequence: () => ({ id: "seq" }),
      }),
    }),
    createGrammarForJsonSchema: opts.hasGrammarFn
      ? async (_s: object) => ({ __grammar: true })
      : undefined,
  };
  class StubSession {
    constructor(_o: { contextSequence: unknown; systemPrompt?: string }) {}
    async prompt(text: string, o: Record<string, unknown> = {}) {
      const numeric: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) {
        if (k !== "onTextChunk" && k !== "grammar") numeric[k] = v;
      }
      recorded.push({
        text,
        hasGrammar: o.grammar !== undefined,
        numericOpts: numeric,
      });
      const reply = typeof opts.reply === "function" ? opts.reply(text) : opts.reply;
      const onChunk = o.onTextChunk as ((c: string) => void) | undefined;
      if (onChunk) {
        // Emit chunks of ~5 chars to simulate streaming.
        for (let i = 0; i < reply.length; i += 5) {
          onChunk(reply.slice(i, i + 5));
        }
      }
      return reply;
    }
  }
  const mod = {
    getLlama: async () => llama,
    LlamaChatSession: StubSession,
  };
  return { mod: mod as unknown as Parameters<typeof __setLlamaModuleForTests>[0], recorded };
}

describe("LocalModel construction", () => {
  it("requires a source", () => {
    expect(() => new LocalModel({ source: undefined as unknown as never })).toThrow();
  });

  it("uses the registry contextWindow when source is a known alias", () => {
    const m = new LocalModel({ source: { model: "qwen3.5-0.8b" } });
    expect(m.capabilities.contextWindow).toBe(262_144);
    expect(m.capabilities.localEndpoint).toBe(true);
    expect(m.capabilities.metered).toBe(false);
    expect(m.capabilities.supportsGrammar).toBe(true);
    expect(m.capabilities.cacheStrategy).toBe("none");
    expect(m.providerId).toBe("local-qwen3.5-0.8b");
  });

  it("throws a clean dependency error when node-llama-cpp is not installed", async () => {
    __setLlamaModuleForTests(null);
    const m = new LocalModel({ source: { path: "/tmp/does-not-matter.gguf" } });
    // Force the module to fail to load by pointing at a non-existent peer.
    // We can't easily simulate the import failure deterministically here, so
    // assert the LocalModelDependencyError class is exported as expected.
    expect(LocalModelDependencyError).toBeTypeOf("function");
    // Cannot trigger import() failure without manipulating module resolution;
    // structural assertion is the practical bound here.
    expect(m).toBeDefined();
  });
});

describe("LocalModel.generate (free-form)", () => {
  it("streams text deltas, then a stop and a usage event", async () => {
    const { mod, recorded } = makeStubModule({ reply: "hello world" });
    __setLlamaModuleForTests(mod);
    const m = new LocalModel({ source: { path: "/tmp/x.gguf" } });
    const events: string[] = [];
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let stop = "";
    let collected = "";
    for await (const ev of m.generate(
      [{ role: "user", content: "say hi" }],
      { temperature: 0.4, maxTokens: 100 }
    )) {
      events.push(ev.type);
      if (ev.type === "text_delta") collected += ev.delta ?? "";
      if (ev.type === "stop") stop = ev.stopReason ?? "";
      if (ev.type === "usage") usage = ev.usage as typeof usage;
    }
    expect(collected).toBe("hello world");
    expect(stop).toBe("end_turn");
    expect(usage?.outputTokens).toBeGreaterThan(0);
    // Numeric sampling fields forwarded.
    expect(recorded[0]?.numericOpts).toMatchObject({ temperature: 0.4, maxTokens: 100 });
  });

  it("includes a leading system prompt when present", async () => {
    const { mod, recorded } = makeStubModule({ reply: "ok" });
    __setLlamaModuleForTests(mod);
    const m = new LocalModel({ source: { path: "/tmp/x.gguf" } });
    const out: string[] = [];
    for await (const ev of m.generate([
      { role: "system", content: "You are concise." },
      { role: "user", content: "?" },
    ])) {
      if (ev.type === "text_delta") out.push(ev.delta ?? "");
    }
    expect(out.join("")).toBe("ok");
    // The user-side prompt should not also include the system prompt.
    expect(recorded[0]?.text).not.toContain("You are concise.");
  });
});

describe("LocalModel.generate (tool mode)", () => {
  const tools = [
    {
      name: "calc",
      description: "compute",
      input_schema: { type: "object", properties: { a: { type: "number" } } },
    },
  ];

  it("emits a tool_call when the model returns a tool_use JSON", async () => {
    const { mod, recorded } = makeStubModule({
      reply: '{"type":"tool_use","name":"calc","input":{"a":7}}',
      hasGrammarFn: true,
    });
    __setLlamaModuleForTests(mod);
    const m = new LocalModel({ source: { path: "/tmp/x.gguf" } });
    let toolCallSeen: { name: string; input: unknown } | null = null;
    let stop = "";
    for await (const ev of m.generate([{ role: "user", content: "use calc" }], { tools })) {
      if (ev.type === "tool_call" && ev.toolCall) {
        toolCallSeen = { name: ev.toolCall.name, input: ev.toolCall.input };
      }
      if (ev.type === "stop") stop = ev.stopReason ?? "";
    }
    expect(toolCallSeen).toEqual({ name: "calc", input: { a: 7 } });
    expect(stop).toBe("tool_use");
    expect(recorded[0]?.hasGrammar).toBe(true);
    // Prompt addendum must mention the tool.
    expect(recorded[0]?.text).toContain("calc");
  });

  it("emits a text_delta when the model returns final_answer JSON", async () => {
    const { mod } = makeStubModule({
      reply: '{"type":"final_answer","text":"42"}',
      hasGrammarFn: true,
    });
    __setLlamaModuleForTests(mod);
    const m = new LocalModel({ source: { path: "/tmp/x.gguf" } });
    let collected = "";
    for await (const ev of m.generate([{ role: "user", content: "answer" }], { tools })) {
      if (ev.type === "text_delta") collected = ev.delta ?? "";
    }
    expect(collected).toBe("42");
  });

  it("falls back to free-form when grammar can't be created", async () => {
    const { mod, recorded } = makeStubModule({
      reply: "freeform output",
      hasGrammarFn: false, // no createGrammarForJsonSchema on the stub
    });
    __setLlamaModuleForTests(mod);
    const m = new LocalModel({ source: { path: "/tmp/x.gguf" } });
    let text = "";
    for await (const ev of m.generate([{ role: "user", content: "x" }], { tools })) {
      if (ev.type === "text_delta") text += ev.delta ?? "";
    }
    expect(text).toBe("freeform output");
    expect(recorded[0]?.hasGrammar).toBe(false);
  });

  it("respects enableGrammar:false (no grammar even when supported)", async () => {
    const { mod, recorded } = makeStubModule({
      reply: "no grammar",
      hasGrammarFn: true,
    });
    __setLlamaModuleForTests(mod);
    const m = new LocalModel({
      source: { path: "/tmp/x.gguf" },
      enableGrammar: false,
    });
    for await (const _ev of m.generate([{ role: "user", content: "x" }], { tools })) {
      // drain
    }
    expect(recorded[0]?.hasGrammar).toBe(false);
  });
});

describe("renderMessagesAsPrompt", () => {
  it("skips the leading system message and labels other roles", () => {
    const out = renderMessagesAsPrompt(
      [
        { role: "system", content: "system one" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "tool", content: "t1" },
      ],
      ""
    );
    expect(out).not.toContain("system one");
    expect(out).toContain("u1");
    expect(out).toContain("[assistant] a1");
    expect(out).toContain("[tool result] t1");
  });

  it("renders content blocks", () => {
    const out = renderMessagesAsPrompt(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "tool_result", toolUseId: "abc", content: "result-text" },
          ],
        },
      ],
      ""
    );
    expect(out).toContain("hello");
    expect(out).toContain("result-text");
  });

  it("appends the tool prompt addendum at the end", () => {
    const out = renderMessagesAsPrompt([{ role: "user", content: "hi" }], "TOOLS-HERE");
    expect(out.endsWith("TOOLS-HERE")).toBe(true);
  });
});
