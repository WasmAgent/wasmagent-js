import { describe, expect, it } from "vitest";
import { upgradeCardSyntax } from "./upgradeCardSyntax.js";

describe("upgradeCardSyntax", () => {
  it("leaves already-card-fenced text unchanged", () => {
    const input = "```card:d2\nA -> B\n```";
    expect(upgradeCardSyntax(input)).toBe(input);
  });

  it("upgrades ```d2 fence to ```card:d2", () => {
    const input = "Here is the diagram:\n\n```d2\ndirection: right\nA -> B -> C\n```";
    const result = upgradeCardSyntax(input);
    expect(result).toContain("```card:d2");
    expect(result).not.toMatch(/```d2\n/);
  });

  it("wraps bare D2 content (no fences) in card:d2", () => {
    const input = "direction: right\nfrontend -> api: HTTPS\napi -> db: SQL";
    const result = upgradeCardSyntax(input);
    expect(result).toContain("```card:d2");
    expect(result).toContain("frontend -> api");
  });

  it("does NOT wrap rich Markdown with headings — chat replies render inline", () => {
    // Cards are reserved for produced artefacts (D2 diagrams, generated docs).
    // A heading + table in a normal chat reply must stay as plain Markdown so
    // the chat UI renders it inline rather than collapsing it into a card
    // placeholder. See 2026-06-17 regression — "你好" reply with a heading
    // intro was being turned into a `card:markdown` block.
    const input = "## Title\n\nSome text\n\n| A | B |\n|---|---|\n| 1 | 2 |";
    expect(upgradeCardSyntax(input)).toBe(input);
  });

  it("does NOT wrap Markdown with only a GFM table — chat replies render inline", () => {
    const input = "| Step | Action |\n|------|--------|\n| 1 | Login |\n| 2 | Submit |";
    expect(upgradeCardSyntax(input)).toBe(input);
  });

  it("does NOT wrap plain text without headings or tables", () => {
    const input = "Here is the result: 42. It is correct.";
    expect(upgradeCardSyntax(input)).toBe(input);
  });

  it("does NOT wrap HTML content", () => {
    const input = "<html><body><h1>Hello</h1></body></html>";
    expect(upgradeCardSyntax(input)).toBe(input);
  });

  it("does NOT wrap text that has code fences for programming languages", () => {
    const input = "Here is the code:\n\n```ts\nconst x = 1;\n```";
    expect(upgradeCardSyntax(input)).toBe(input);
  });

  it("preserves mixed content with card fences already present", () => {
    const input = "Some text\n\n```card:d2\nA -> B\n```\n\nMore text";
    expect(upgradeCardSyntax(input)).toBe(input);
  });

  it("upgrades Chinese D2 content", () => {
    const input = "direction: down\n患者 -> 挂号: 到院\n挂号 -> 候诊: 等待\n候诊 -> 就诊: 叫号";
    const result = upgradeCardSyntax(input);
    expect(result).toContain("```card:d2");
    expect(result).toContain("患者 -> 挂号");
  });

  it("is idempotent — applying twice produces the same result", () => {
    // Use a D2 input since plain Markdown is no longer auto-wrapped.
    const input = "direction: right\nA -> B\nB -> C";
    const once = upgradeCardSyntax(input);
    const twice = upgradeCardSyntax(once);
    expect(once).toBe(twice);
  });
});
