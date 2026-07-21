/**
 * Cross-package integration test.
 *
 * Validates the full data path that bscode uses:
 *
 *   1. Compose a system prompt from @wasmagent/core/prompts fragments.
 *   2. Simulate an AI reply (bare D2 / Markdown — testing the auto-upgrade path).
 *   3. Run upgradeCardSyntax (from @wasmagent/ui-cards) to wrap content.
 *   4. Run parseCardBlocks (also @wasmagent/ui-cards) to extract card structure.
 *   5. Verify the result matches what UI components would render.
 *
 * If this test passes, bscode's full pipeline is wire-correct from
 * prompt construction through final card extraction. UI rendering is
 * tested separately in @wasmagent/ui-cards-react smoke tests.
 */

import { describe, expect, it } from "bun:test";
import {
  CODE_QUALITY_GENERIC,
  composePrompt,
  DIAGRAMS_CODE_JS,
  DIAGRAMS_GENERIC,
  ERROR_RECOVERY,
  OUTPUT_CONTRACT_FINAL_ANSWER,
  REASONING_FIRST,
  SANDBOX_QUICKJS,
} from "@wasmagent/core/prompts";
import { parseCardBlocks, upgradeCardSyntax } from "@wasmagent/ui-cards";

describe("cross-package integration: prompts → AI reply → upgrade → parse", () => {
  it("composes a JS code-agent prompt that includes all expected sections", () => {
    const prompt = composePrompt({
      persona: "You are an expert JavaScript coding assistant.",
      fragments: [
        REASONING_FIRST,
        SANDBOX_QUICKJS,
        OUTPUT_CONTRACT_FINAL_ANSWER,
        CODE_QUALITY_GENERIC,
        DIAGRAMS_CODE_JS,
        ERROR_RECOVERY,
      ],
    });

    // Spec checks
    expect(prompt).toContain("expert JavaScript coding assistant");
    expect(prompt).toContain("Reasoning-First");
    expect(prompt).toContain("__finalAnswer__");
    expect(prompt).toContain("card:d2");
    expect(prompt).toContain("Error Recovery");
    expect(prompt).toContain("Code Quality");

    // Generic-foundation guard: no product-specific tokens
    expect(prompt).not.toMatch(/bscode/i);
    expect(prompt).not.toMatch(/lovable/i);
    expect(prompt).not.toMatch(/v0\.dev/i);
  });

  it("composes a tool-agent prompt with both diagram + markdown card rules", () => {
    const prompt = composePrompt({
      persona: "You are a generic coding assistant.",
      fragments: [REASONING_FIRST, DIAGRAMS_GENERIC],
    });
    expect(prompt).toContain("```card:d2");
    expect(prompt).toContain("```card:markdown");
  });

  it("upgrades + parses bare D2 content the AI emitted without card fence", () => {
    // Simulate an AI that ignored the card-block instruction and emitted
    // raw D2 source — the consumer's auto-upgrade pre-processor catches it.
    const aiReply = `direction: right
frontend -> api: HTTPS
api -> db: SQL
api -> cache: Redis`;

    const upgraded = upgradeCardSyntax(aiReply);
    expect(upgraded).toContain("```card:d2");

    const parsed = parseCardBlocks(upgraded);
    expect(parsed.cards).toHaveLength(1);
    expect(parsed.cards[0]?.type).toBe("d2");
    expect(parsed.cards[0]?.content).toContain("frontend -> api");
  });

  it("leaves bare rich Markdown untouched (plain chat reply, not wrapped as card)", () => {
    const aiReply = `## Analysis Report

| Metric | Value |
|--------|-------|
| Latency | 120ms |
| Errors | 0.4% |

**Conclusion**: System is healthy.`;

    const upgraded = upgradeCardSyntax(aiReply);
    // Plain Markdown is rendered inline — upgradeCardSyntax only wraps D2 diagrams
    expect(upgraded).toBe(aiReply);
    expect(upgraded).not.toContain("```card:");
  });

  it("preserves already-fenced cards through the upgrade + parse round-trip", () => {
    const aiReply = `Here is the diagram:

\`\`\`card:d2 service-arch
direction: right
frontend -> api
api -> db
\`\`\`

And a summary:

\`\`\`card:markdown
## Summary
Three components, two connections.
\`\`\``;

    const upgraded = upgradeCardSyntax(aiReply);
    const parsed = parseCardBlocks(upgraded);

    expect(parsed.cards).toHaveLength(2);
    expect(parsed.cards[0]?.type).toBe("d2");
    expect(parsed.cards[0]?.meta).toBe("service-arch");
    expect(parsed.cards[1]?.type).toBe("markdown");

    // Text segments are interleaved
    const segs = parsed.segments;
    expect(segs[0]?.kind).toBe("text");
    expect(segs[1]?.kind).toBe("card");
    expect(segs[2]?.kind).toBe("text");
    expect(segs[3]?.kind).toBe("card");
  });

  it("handles streaming partials gracefully", () => {
    // Mid-stream partial — closing fence not yet received
    const partial = "Here is a diagram:\n\n```card:d2\nfrontend -> api";
    const upgraded = upgradeCardSyntax(partial);
    const parsed = parseCardBlocks(upgraded);
    // Partial fence is treated as text, not as a card
    expect(parsed.cards).toHaveLength(0);
    expect(parsed.segments.some((s) => s.kind === "text")).toBe(true);
  });

  it("integration: bscode's exact data-flow on Chinese D2 input", () => {
    // Real-world failure case from BSCode that the upgrade path resolves.
    const aiReply = `direction: down
患者到院 -> 挂号: 等待
挂号 -> 候诊: 叫号
候诊 -> 诊断: 医生问诊
诊断 -> 药房: 取药
药房 -> 离院: 完成`;

    const upgraded = upgradeCardSyntax(aiReply);
    const parsed = parseCardBlocks(upgraded);

    expect(parsed.cards).toHaveLength(1);
    expect(parsed.cards[0]?.type).toBe("d2");
    // CJK content preserved
    expect(parsed.cards[0]?.content).toContain("患者到院");
    expect(parsed.cards[0]?.content).toContain("药房");
  });

  it("does not double-wrap when run twice (idempotent)", () => {
    const aiReply = "## Hello\n\n| A | B |\n|---|---|\n| 1 | 2 |";
    const once = upgradeCardSyntax(aiReply);
    const twice = upgradeCardSyntax(once);
    expect(once).toBe(twice);

    const parsedOnce = parseCardBlocks(once);
    const parsedTwice = parseCardBlocks(twice);
    expect(parsedOnce.cards.length).toBe(parsedTwice.cards.length);
    expect(parsedOnce.cards[0]?.content).toBe(parsedTwice.cards[0]?.content);
  });
});

describe("guard: agent-prompts and ui-cards do not contain product-specific tokens", () => {
  // This is a runtime smoke test — confirms imports resolve correctly
  // AND none of the source surfaces leak bscode/Lovable/v0 names.
  it("agent-prompts fragments are product-agnostic", () => {
    const allFragments = [
      REASONING_FIRST,
      SANDBOX_QUICKJS,
      OUTPUT_CONTRACT_FINAL_ANSWER,
      CODE_QUALITY_GENERIC,
      DIAGRAMS_CODE_JS,
      DIAGRAMS_GENERIC,
      ERROR_RECOVERY,
    ].join("\n\n");

    expect(allFragments).not.toMatch(/bscode/i);
    expect(allFragments).not.toContain("BSCode");
    expect(allFragments).not.toContain("Lovable");
    expect(allFragments).not.toContain("v0.dev");
    expect(allFragments).not.toContain("WebContainers");
    expect(allFragments).not.toContain("boltThinking");
    expect(allFragments).not.toContain("bolt.new");
  });
});
