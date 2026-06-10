import { describe, expect, it } from "vitest";
import { CardRenderer, ChatMessage, type ChatMessageInput, D2Card, MarkdownCard } from "./index.js";

describe("@agentkit-js/ui-cards-react exports", () => {
  it("exports MarkdownCard component", () => {
    expect(typeof MarkdownCard).toBe("function");
    expect(MarkdownCard.name).toBe("MarkdownCard");
  });

  it("exports D2Card component", () => {
    expect(typeof D2Card).toBe("function");
    expect(D2Card.name).toBe("D2Card");
  });

  it("exports CardRenderer component", () => {
    expect(typeof CardRenderer).toBe("function");
    expect(CardRenderer.name).toBe("CardRenderer");
  });

  it("exports ChatMessage component", () => {
    expect(typeof ChatMessage).toBe("function");
    expect(ChatMessage.name).toBe("ChatMessage");
  });
});

describe("ChatMessageInput type", () => {
  it("accepts a structurally compatible message object", () => {
    const msg: ChatMessageInput = {
      id: "msg-1",
      role: "assistant",
      content: "Hello world",
    };
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("Hello world");
  });

  it("supports tool and error roles", () => {
    const tool: ChatMessageInput = {
      id: "t1",
      role: "tool",
      content: "calc done",
      toolName: "calc",
    };
    const err: ChatMessageInput = { id: "e1", role: "error", content: "boom", isError: true };
    expect(tool.toolName).toBe("calc");
    expect(err.isError).toBe(true);
  });
});

describe("generic-foundation principle", () => {
  // The package must be product-agnostic. No bscode-specific tokens
  // should leak in.
  it("no exported component name references a specific product", () => {
    const allNames = [MarkdownCard.name, D2Card.name, CardRenderer.name, ChatMessage.name];
    for (const name of allNames) {
      expect(name).not.toMatch(/bscode/i);
      expect(name).not.toMatch(/lovable/i);
      expect(name).not.toMatch(/bolt/i);
    }
  });
});
