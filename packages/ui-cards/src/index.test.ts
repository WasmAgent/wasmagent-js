import { parseCardBlocks } from "./index.js";

describe("parseCardBlocks", () => {
  it("plain text with no cards returns single text segment", () => {
    const result = parseCardBlocks("Hello world");
    expect(result.cards).toHaveLength(0);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toEqual({ kind: "text", content: "Hello world" });
  });

  it("empty string returns empty segments", () => {
    const result = parseCardBlocks("");
    expect(result.cards).toHaveLength(0);
  });

  it("single markdown card", () => {
    const text = "```card:markdown\n## Hello\n| a | b |\n```";
    const result = parseCardBlocks(text);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toMatchObject({
      id: "card-0",
      type: "markdown",
      content: "## Hello\n| a | b |",
    });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.kind).toBe("card");
  });

  it("text before and after card", () => {
    const text = "Here is a summary:\n```card:markdown\n## Summary\n```\nAny questions?";
    const result = parseCardBlocks(text);
    expect(result.cards).toHaveLength(1);
    expect(result.segments).toHaveLength(3);
    expect(result.segments[0]).toEqual({ kind: "text", content: "Here is a summary:" });
    expect(result.segments[1]?.kind).toBe("card");
    expect(result.segments[2]).toEqual({ kind: "text", content: "Any questions?" });
  });

  it("d2 card with type", () => {
    const text = "```card:d2\ndirection: right\nA -> B\n```";
    const result = parseCardBlocks(text);
    expect(result.cards[0]).toMatchObject({ type: "d2", content: "direction: right\nA -> B" });
  });

  it("card with meta annotation", () => {
    const text = "```card:d2 my-diagram\nA -> B\n```";
    const result = parseCardBlocks(text);
    expect(result.cards[0]).toMatchObject({ meta: "my-diagram", type: "d2" });
  });

  it("multiple cards in sequence", () => {
    const text = ["```card:markdown", "# Card 1", "```", "```card:d2", "A -> B", "```"].join("\n");
    const result = parseCardBlocks(text);
    expect(result.cards).toHaveLength(2);
    expect(result.cards[0]?.type).toBe("markdown");
    expect(result.cards[1]?.type).toBe("d2");
    expect(result.cards[0]?.id).toBe("card-0");
    expect(result.cards[1]?.id).toBe("card-1");
  });

  it("inner nested fence inside markdown card is preserved as content", () => {
    const text = [
      "```card:markdown",
      "## Code Example",
      "```js",
      "const x = 1;",
      "```",
      "More text inside card",
      "```",
    ].join("\n");
    const result = parseCardBlocks(text);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]?.content).toContain("```js");
    expect(result.cards[0]?.content).toContain("const x = 1;");
    expect(result.cards[0]?.content).toContain("More text inside card");
  });

  it("unterminated card (streaming partial) falls back to text", () => {
    const text = "Some text\n```card:markdown\n## Partial";
    const result = parseCardBlocks(text);
    expect(result.cards).toHaveLength(0);
    const allText = result.segments.map((s) => (s.kind === "text" ? s.content : "")).join("");
    expect(allText).toContain("card:markdown");
    expect(allText).toContain("Partial");
  });

  it("unknown card types are preserved with their type intact", () => {
    const text = "```card:chart\n{type: 'bar'}\n```";
    const result = parseCardBlocks(text);
    expect(result.cards[0]?.type).toBe("chart");
  });

  it("segment ids are unique and stable across multiple cards", () => {
    const text = [
      "```card:markdown\n# A\n```",
      "```card:markdown\n# B\n```",
      "```card:markdown\n# C\n```",
    ].join("\n");
    const result = parseCardBlocks(text);
    const ids = result.cards.map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(["card-0", "card-1", "card-2"]);
  });

  it("recovers when the model escapes the inner closing fence", () => {
    // Some models emit \``` instead of ``` for the inner code-block
    // close inside a card. Without recovery the card never terminates
    // and the whole rest of the message is captured as card content.
    const text = [
      "```card:markdown",
      "## Heading",
      "```js",
      "function foo() { return 1; }",
      "\\```",
      "End of card",
      "```",
      "trailing text",
    ].join("\n");
    const result = parseCardBlocks(text);
    expect(result.cards.length).toBe(1);
    expect(result.cards[0]?.type).toBe("markdown");
    // The content should include the unescaped inner closer so the
    // markdown renderer sees a valid code block.
    expect(result.cards[0]?.content).toContain("```");
    expect(result.cards[0]?.content).not.toContain("\\```");
    // The trailing text is OUTSIDE the card.
    const lastSeg = result.segments.at(-1);
    expect(lastSeg?.kind).toBe("text");
    expect((lastSeg as { content: string }).content).toContain("trailing text");
  });
});
