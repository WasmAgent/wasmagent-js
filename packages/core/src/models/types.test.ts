import { describe, expect, it } from "vitest";
import { convertCompatMessages } from "./OpenAICompatModel.js";
import { getModelMeta, ModelRegistry, TokenBudget } from "./types.js";

describe("getModelMeta — doubao registry and heuristic", () => {
  it("registered doubao-seed-1-6-251015 is reasoning + supportsReasoningEffort", () => {
    const meta = getModelMeta("doubao-seed-1-6-251015");
    expect(meta.isReasoning).toBe(true);
    expect(meta.supportsReasoningEffort).toBe(true);
    expect(meta.defaultEffort).toBe("medium");
  });

  it("registered doubao-1-5-pro-32k is non-reasoning", () => {
    const meta = getModelMeta("doubao-1-5-pro-32k");
    expect(meta.isReasoning).toBe(false);
    expect(meta.supportsReasoningEffort).toBe(false);
  });

  it("unknown doubao-* falls back to reasoning via heuristic", () => {
    const meta = getModelMeta("doubao-seed-9-9-999999");
    expect(meta.isReasoning).toBe(true);
    expect(meta.supportsReasoningEffort).toBe(true);
  });

  it("endpoint-ID style ep-xxx falls through to default (not doubao heuristic)", () => {
    // ep-xxx doesn't start with "doubao" — falls to generic default
    const meta = getModelMeta("ep-abc123");
    // Generic fallback: isReasoning false (endpoint IDs are not doubao-prefixed)
    expect(meta.isReasoning).toBe(false);
  });
});

describe("getModelMeta — DeepSeek registry", () => {
  it("deepseek-v4-pro supportsReasoningEffort:true", () => {
    expect(getModelMeta("deepseek-v4-pro").supportsReasoningEffort).toBe(true);
  });

  it("deepseek-v4-flash registered and supportsReasoningEffort:true", () => {
    const meta = getModelMeta("deepseek-v4-flash");
    expect(meta.isReasoning).toBe(true);
    expect(meta.supportsReasoningEffort).toBe(true);
  });
});

describe("getModelMeta — Kimi registry", () => {
  it("kimi-k2.6 contextWindow:262000", () => {
    expect(getModelMeta("kimi-k2.6").contextWindow).toBe(262_000);
  });
});

describe("getModelMeta — MiniMax registry", () => {
  it("MiniMax-M2.7 isReasoning:true", () => {
    expect(getModelMeta("MiniMax-M2.7").isReasoning).toBe(true);
  });

  it("MiniMax-M3 isReasoning:true", () => {
    expect(getModelMeta("MiniMax-M3").isReasoning).toBe(true);
  });

  it("minimax-text-01 isReasoning:false", () => {
    expect(getModelMeta("minimax-text-01").isReasoning).toBe(false);
  });
});

// ── L12: convertCompatMessages round-trip policy ────────────────────────────

type ThinkingBlock = { type: "thinking"; thinking: string };
type TextBlock = { type: "text"; text: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

describe("convertCompatMessages — reasoning round-trip policy", () => {
  const thinkingBlock: ThinkingBlock = { type: "thinking", thinking: "Let me reason..." };
  const textBlock: TextBlock = { type: "text", text: "The answer is 42" };
  const toolUseBlock: ToolUseBlock = {
    type: "tool_use",
    id: "tc1",
    name: "calculator",
    input: { x: 1 },
  };

  it("policy:never — thinking block discarded (default behavior)", () => {
    const msgs = convertCompatMessages(
      [
        { role: "user", content: "question" },
        { role: "assistant", content: [thinkingBlock, textBlock] },
      ],
      "never"
    );
    const assistant = msgs.find(
      (m: unknown) => (m as Record<string, unknown>).role === "assistant"
    ) as Record<string, unknown> | undefined;
    expect(assistant?.reasoning_content).toBeUndefined();
    expect(assistant?.content).toBe("The answer is 42");
  });

  it("policy:tool-turns-only — reasoning_content echoed when assistant has tool_use", () => {
    const msgs = convertCompatMessages(
      [
        { role: "user", content: "question" },
        { role: "assistant", content: [thinkingBlock, toolUseBlock] },
      ],
      "tool-turns-only"
    );
    const assistant = msgs.find((m: unknown) => {
      const r = m as Record<string, unknown>;
      return r.role === "assistant" && Array.isArray(r.tool_calls);
    }) as Record<string, unknown> | undefined;
    expect(assistant?.reasoning_content).toBe("Let me reason...");
  });

  it("policy:tool-turns-only — reasoning_content NOT echoed when assistant has no tool_use", () => {
    const msgs = convertCompatMessages(
      [
        { role: "user", content: "question" },
        { role: "assistant", content: [thinkingBlock, textBlock] },
      ],
      "tool-turns-only"
    );
    const assistant = msgs.find(
      (m: unknown) => (m as Record<string, unknown>).role === "assistant"
    ) as Record<string, unknown> | undefined;
    expect(assistant?.reasoning_content).toBeUndefined();
  });

  it("policy:always — reasoning_content echoed even without tool_use", () => {
    const msgs = convertCompatMessages(
      [
        { role: "user", content: "question" },
        { role: "assistant", content: [thinkingBlock, textBlock] },
      ],
      "always"
    );
    const assistant = msgs.find(
      (m: unknown) => (m as Record<string, unknown>).role === "assistant"
    ) as Record<string, unknown> | undefined;
    expect(assistant?.reasoning_content).toBe("Let me reason...");
  });

  it("boolean true legacy compat → same as 'always'", () => {
    const msgs = convertCompatMessages(
      [
        { role: "user", content: "q" },
        { role: "assistant", content: [thinkingBlock, textBlock] },
      ],
      true
    );
    const assistant = msgs.find(
      (m: unknown) => (m as Record<string, unknown>).role === "assistant"
    ) as Record<string, unknown> | undefined;
    expect(assistant?.reasoning_content).toBe("Let me reason...");
  });

  it("boolean false legacy compat → same as 'never'", () => {
    const msgs = convertCompatMessages(
      [
        { role: "user", content: "q" },
        { role: "assistant", content: [thinkingBlock, textBlock] },
      ],
      false
    );
    const assistant = msgs.find(
      (m: unknown) => (m as Record<string, unknown>).role === "assistant"
    ) as Record<string, unknown> | undefined;
    expect(assistant?.reasoning_content).toBeUndefined();
  });

  it("tool_call_id is paired correctly in two-turn tool conversation", () => {
    const msgs = convertCompatMessages(
      [
        { role: "user", content: "calc 1+1" },
        { role: "assistant", content: [thinkingBlock, toolUseBlock] },
        {
          role: "user",
          content: [{ type: "tool_result" as const, toolUseId: "tc1", content: "2" }],
        },
      ],
      "tool-turns-only"
    );
    const toolResult = msgs.find((m: unknown) => (m as Record<string, unknown>).role === "tool") as
      | Record<string, unknown>
      | undefined;
    expect(toolResult?.tool_call_id).toBe("tc1");
  });
});

describe("TokenBudget — model-aware estimatedUsdFor", () => {
  function fillBudget(b: TokenBudget) {
    b.recordUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  }

  it("Sonnet 4.6 uses $3 input / $15 output (= $18 per 1M+1M)", () => {
    const b = new TokenBudget();
    fillBudget(b);
    expect(b.estimatedUsdFor("claude-sonnet-4-6")).toBeCloseTo(3 + 15, 6);
  });

  it("Haiku 4.5 uses $0.80 input / $4 output (= $4.80 per 1M+1M)", () => {
    const b = new TokenBudget();
    fillBudget(b);
    expect(b.estimatedUsdFor("claude-haiku-4-5-20251001")).toBeCloseTo(0.8 + 4, 6);
  });

  it("Opus 4.8 uses $15 input / $75 output (= $90 per 1M+1M)", () => {
    const b = new TokenBudget();
    fillBudget(b);
    expect(b.estimatedUsdFor("claude-opus-4-8")).toBeCloseTo(15 + 75, 6);
  });

  it("GPT-5 uses $1.25 input / $10 output (= $11.25 per 1M+1M)", () => {
    const b = new TokenBudget();
    fillBudget(b);
    expect(b.estimatedUsdFor("gpt-5")).toBeCloseTo(1.25 + 10, 6);
  });

  it("Haiku is materially cheaper than Sonnet on the same usage", () => {
    const b = new TokenBudget();
    fillBudget(b);
    const haiku = b.estimatedUsdFor("claude-haiku-4-5-20251001");
    const sonnet = b.estimatedUsdFor("claude-sonnet-4-6");
    // Haiku should be < 1/3 of Sonnet for the same token mix.
    expect(haiku).toBeLessThan(sonnet / 3);
  });

  it("cache reads are billed at the cacheReadUsdPerMTok rate (Sonnet → $0.30 / 1M)", () => {
    const b = new TokenBudget();
    b.recordUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 });
    expect(b.estimatedUsdFor("claude-sonnet-4-6")).toBeCloseTo(0.3, 6);
  });

  it("unknown model falls back to Sonnet pricing (informational)", () => {
    const b = new TokenBudget();
    fillBudget(b);
    expect(b.estimatedUsdFor("model-that-does-not-exist")).toBeCloseTo(3 + 15, 6);
  });

  it("deprecated estimatedUsd getter equals Sonnet pricing for back-compat", () => {
    const b = new TokenBudget();
    fillBudget(b);
    // Deprecated getter — same as estimatedUsdFor() with no model.
    expect(b.estimatedUsd).toBeCloseTo(b.estimatedUsdFor(), 6);
    expect(b.estimatedUsd).toBeCloseTo(3 + 15, 6);
  });

  it("ModelRegistry has price metadata for every shipped Anthropic + OpenAI ID", () => {
    // Guards against silent regression where a new model entry lands without prices.
    const required = [
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "gpt-5",
      "gpt-5-mini",
      "gpt-5-nano",
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1",
      "o3",
      "o4-mini",
      "o3-mini",
    ];
    for (const id of required) {
      const meta = ModelRegistry[id];
      expect(meta, `missing ${id} in ModelRegistry`).toBeDefined();
      expect(meta!.inputUsdPerMTok, `missing inputUsdPerMTok on ${id}`).toBeGreaterThan(0);
      expect(meta!.outputUsdPerMTok, `missing outputUsdPerMTok on ${id}`).toBeGreaterThan(0);
    }
  });
});
