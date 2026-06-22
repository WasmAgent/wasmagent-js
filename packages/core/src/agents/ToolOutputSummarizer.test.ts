import { summarizeToolOutput } from "./ToolOutputSummarizer.js";

describe("summarizeToolOutput", () => {
  test("short output returned verbatim", () => {
    const s = "hello world";
    expect(summarizeToolOutput(s)).toBe(s);
  });

  test("empty string returned verbatim", () => {
    expect(summarizeToolOutput("")).toBe("");
  });

  test("output exactly at maxBytes returned verbatim", () => {
    const s = "x".repeat(800);
    expect(summarizeToolOutput(s, { maxBytes: 800 })).toBe(s);
  });

  test("long output keeps head and tail with omission marker", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const raw = lines.join("\n");
    const result = summarizeToolOutput(raw, {
      maxBytes: 10,
      keepFirstLines: 2,
      keepLastLines: 2,
    });
    expect(result).toContain("line0");
    expect(result).toContain("line1");
    expect(result).toContain("[...16 lines omitted...]");
    expect(result).toContain("line18");
    expect(result).toContain("line19");
    // Middle lines must not appear
    expect(result).not.toContain("line5");
  });

  test("omitted count is correct", () => {
    // 10 lines, keep 3 + 5 = 8, so 2 omitted
    const lines = Array.from({ length: 10 }, (_, i) => `L${i}`);
    const result = summarizeToolOutput(lines.join("\n"), { maxBytes: 1 });
    expect(result).toContain("[...2 lines omitted...]");
  });

  test("head+tail overlap returns original without marker", () => {
    // 5 lines, keep 3 first + 5 last = would overlap
    const lines = ["a", "b", "c", "d", "e"];
    const raw = lines.join("\n");
    const result = summarizeToolOutput(raw, { maxBytes: 1, keepFirstLines: 3, keepLastLines: 5 });
    expect(result).toBe(raw);
    expect(result).not.toContain("omitted");
  });

  test("default options: maxBytes=800, head=3, tail=5", () => {
    // Generate a string > 800 bytes with many lines
    const lines = Array.from({ length: 50 }, (_, i) => `line${i} ${"x".repeat(20)}`);
    const raw = lines.join("\n");
    const result = summarizeToolOutput(raw);
    const resultLines = result.split("\n");
    // First 3 lines preserved
    expect(resultLines[0]).toBe(lines[0]);
    expect(resultLines[2]).toBe(lines[2]);
    // Omission marker at position 3
    expect(resultLines[3]).toMatch(/\[\.\.\.42 lines omitted\.\.\.\]/);
    // Last 5 lines preserved
    expect(resultLines[resultLines.length - 1]).toBe(lines[49]);
    expect(resultLines[resultLines.length - 5]).toBe(lines[45]);
  });
});
