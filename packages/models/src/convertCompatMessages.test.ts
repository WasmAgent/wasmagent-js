import { convertCompatMessages } from "./OpenAICompatModel.js";

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
