import { describe, expect, it } from "vitest";
import { convertCompatMessages } from "./OpenAICompatModel.js";
import type { ModelMessage } from "./types.js";

describe("convertCompatMessages", () => {
  it("passes through system messages", () => {
    const result = convertCompatMessages([
      { role: "system", content: "You are helpful." },
    ]) as Array<Record<string, unknown>>;
    expect(result[0]).toEqual({ role: "system", content: "You are helpful." });
  });

  it("passes through string user/assistant messages", () => {
    const result = convertCompatMessages([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]) as Array<Record<string, unknown>>;
    expect(result[0]).toEqual({ role: "user", content: "hello" });
    expect(result[1]).toEqual({ role: "assistant", content: "world" });
  });

  it("skips thinking blocks by default (roundTripReasoning=false)", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "deep thought" },
          { type: "text", text: "answer" },
        ],
      },
    ];
    const result = convertCompatMessages(messages) as Array<Record<string, unknown>>;
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.reasoning_content).toBeUndefined();
    expect(msg.content).toBe("answer");
  });

  it("echoes reasoning_content in assistant message when roundTripReasoning=true", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "deep thought" },
          { type: "text", text: "answer" },
        ],
      },
    ];
    const result = convertCompatMessages(messages, true) as Array<Record<string, unknown>>;
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.reasoning_content).toBe("deep thought");
    expect(msg.content).toBe("answer");
  });

  it("does NOT add reasoning_content to user messages", () => {
    const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const result = convertCompatMessages(messages, true) as Array<Record<string, unknown>>;
    expect(result[0]?.reasoning_content).toBeUndefined();
  });

  it("handles tool_use + thinking in assistant message correctly", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning about tools" },
          { type: "tool_use", id: "call1", name: "search", input: { q: "test" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolUseId: "call1", content: "result text" }],
      },
    ];
    const result = convertCompatMessages(messages, true) as Array<Record<string, unknown>>;
    // assistant message with tool_calls
    const assistantMsg = result.find((m) => m.role === "assistant") as
      | Record<string, unknown>
      | undefined;
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.reasoning_content).toBe("reasoning about tools");
    const toolCalls = assistantMsg?.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls[0]?.id).toBe("call1");
    // tool result message
    const toolMsg = result.find((m) => m.role === "tool") as Record<string, unknown> | undefined;
    expect(toolMsg?.tool_call_id).toBe("call1");
    expect(toolMsg?.content).toBe("result text");
  });

  it("does not emit reasoning_content on roundTrip=false even with tool_use + thinking", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning" },
          { type: "tool_use", id: "c1", name: "fn", input: {} },
        ],
      },
    ];
    const result = convertCompatMessages(messages, false) as Array<Record<string, unknown>>;
    const assistantMsg = result.find((m) => m.role === "assistant") as
      | Record<string, unknown>
      | undefined;
    expect(assistantMsg?.reasoning_content).toBeUndefined();
  });
});
