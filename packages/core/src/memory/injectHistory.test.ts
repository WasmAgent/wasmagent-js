/**
 * Tests for injectHistoryIntoAssembler (#303).
 */

import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "../models/types.js";
import { injectHistoryIntoAssembler } from "./injectHistory.js";
import { MessageAssembler } from "./MessageAssembler.js";

function makeAssembler(): MessageAssembler {
  return new MessageAssembler({
    systemPrompt: "You are a helpful assistant.",
    toolsSchema: [],
  });
}

describe("injectHistoryIntoAssembler (#303)", () => {
  test("injects pure text turns into the assembler", () => {
    const assembler = makeAssembler();
    const messages: ModelMessage[] = [
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
    ];
    injectHistoryIntoAssembler(assembler, messages);
    const built = assembler.build();
    // system message + injected messages
    const roles = built.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    const userMsg = built.find((m) => m.role === "user" && m.content === "What is 2+2?");
    const assistantMsg = built.find((m) => m.role === "assistant" && m.content === "4");
    expect(userMsg).toBeDefined();
    expect(assistantMsg).toBeDefined();
  });

  test("injects single tool_use + tool_result pair", () => {
    const assembler = makeAssembler();
    const messages: ModelMessage[] = [
      { role: "user", content: "Search for cats" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu1",
            name: "web_search",
            input: { query: "cats" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "tu1",
            content: "Cats are popular pets.",
          },
        ],
      },
    ];
    injectHistoryIntoAssembler(assembler, messages);
    const built = assembler.build();
    // Should contain the tool_use assistant message
    const toolUseMsg = built.find(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).some((b) => b.type === "tool_use")
    );
    expect(toolUseMsg).toBeDefined();
    // Should contain the tool_result user message
    const toolResultMsg = built.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).some((b) => b.type === "tool_result")
    );
    expect(toolResultMsg).toBeDefined();
  });

  test("injects parallel tool_use blocks (multiple calls in one message)", () => {
    const assembler = makeAssembler();
    const messages: ModelMessage[] = [
      { role: "user", content: "Search and calculate" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu1", name: "web_search", input: { query: "cats" } },
          { type: "tool_use", id: "tu2", name: "calculator", input: { expr: "2+2" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "tu1", content: "Cats are popular." },
          { type: "tool_result", toolUseId: "tu2", content: "4" },
        ],
      },
    ];
    injectHistoryIntoAssembler(assembler, messages);
    const built = assembler.build();
    const parallelUseMsg = built.find(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).filter((b) => b.type === "tool_use").length === 2
    );
    expect(parallelUseMsg).toBeDefined();
    const parallelResultMsg = built.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).filter((b) => b.type === "tool_result").length === 2
    );
    expect(parallelResultMsg).toBeDefined();
  });

  test("empty history leaves assembler unchanged (only system message)", () => {
    const assembler = makeAssembler();
    injectHistoryIntoAssembler(assembler, []);
    const built = assembler.build();
    // Only the system message should be present
    expect(built).toHaveLength(1);
    expect(built[0]?.role).toBe("system");
  });

  test("messages injected appear in order in build() output", () => {
    const assembler = makeAssembler();
    const messages: ModelMessage[] = [
      { role: "user", content: "First" },
      { role: "assistant", content: "Second" },
      { role: "user", content: "Third" },
    ];
    injectHistoryIntoAssembler(assembler, messages);
    const built = assembler.build();
    const nonSystem = built.filter((m) => m.role !== "system");
    expect(nonSystem[0]?.content).toBe("First");
    expect(nonSystem[1]?.content).toBe("Second");
    expect(nonSystem[2]?.content).toBe("Third");
  });
});
