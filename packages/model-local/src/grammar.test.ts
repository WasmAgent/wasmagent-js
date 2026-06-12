/**
 * Grammar / tool-extraction unit tests — pure logic, no native binding.
 */

import { describe, expect, it } from "vitest";
import {
  buildResponseFormatSchema,
  buildToolCallSchema,
  buildToolPromptAddendum,
  extractTools,
  parseToolCallOutput,
} from "./grammar.js";

describe("extractTools", () => {
  it("handles Anthropic-shape tool definitions", () => {
    const tools = [
      {
        name: "get_weather",
        description: "Look up weather",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ];
    const out = extractTools(tools);
    expect(out).toEqual([
      {
        name: "get_weather",
        description: "Look up weather",
        inputSchema: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);
  });

  it("handles OpenAI-shape (function-wrapper) tool definitions", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Look up a thing",
          parameters: { type: "object", properties: { id: { type: "string" } } },
        },
      },
    ];
    const out = extractTools(tools);
    expect(out[0]?.name).toBe("lookup");
    expect(out[0]?.inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
    });
  });

  it("returns [] for undefined / empty inputs", () => {
    expect(extractTools(undefined)).toEqual([]);
    expect(extractTools([])).toEqual([]);
  });

  it("skips malformed entries instead of throwing", () => {
    const out = extractTools([{ junk: true }, "not-an-object" as unknown as object]);
    expect(out).toEqual([]);
  });
});

describe("buildToolCallSchema", () => {
  it("produces a oneOf with final_answer + each tool branch", () => {
    const schema = buildToolCallSchema([
      {
        name: "search",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]) as { oneOf: Array<Record<string, unknown>> };

    expect(schema.oneOf).toHaveLength(2);
    expect(schema.oneOf[0]?.required).toContain("text");
    const toolBranch = schema.oneOf[1] as {
      properties: { name: { const: string }; input: object };
    };
    expect(toolBranch.properties.name.const).toBe("search");
    expect(toolBranch.properties.input).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
  });
});

describe("buildToolPromptAddendum", () => {
  it("returns empty string for no tools", () => {
    expect(buildToolPromptAddendum([])).toBe("");
  });

  it("includes each tool name and its schema", () => {
    const text = buildToolPromptAddendum([
      { name: "calc", description: "do math", inputSchema: { type: "object" } },
    ]);
    expect(text).toContain("calc — do math");
    expect(text).toContain('input schema: {"type":"object"}');
    expect(text).toContain("Output ONLY a JSON object");
  });
});

describe("parseToolCallOutput", () => {
  it("parses a final_answer", () => {
    const r = parseToolCallOutput('{"type":"final_answer","text":"42"}');
    expect(r.finalAnswer).toBe("42");
    expect(r.toolCall).toBeUndefined();
  });

  it("parses a tool_use", () => {
    const r = parseToolCallOutput('{"type":"tool_use","name":"calc","input":{"a":1}}');
    expect(r.toolCall).toEqual({ name: "calc", input: { a: 1 } });
    expect(r.finalAnswer).toBeUndefined();
  });

  it("tolerates whitespace", () => {
    const r = parseToolCallOutput('  \n {"type":"final_answer","text":"hi"}\n\t  ');
    expect(r.finalAnswer).toBe("hi");
  });

  it("returns parseError on malformed JSON", () => {
    const r = parseToolCallOutput('{"type":"tool_use",na');
    expect(r.parseError).toMatch(/invalid JSON/);
  });

  it("returns parseError on shape mismatch", () => {
    const r = parseToolCallOutput('{"foo":"bar"}');
    expect(r.parseError).toMatch(/did not match/);
  });

  it("returns parseError on empty input", () => {
    expect(parseToolCallOutput("").parseError).toBe("empty output");
  });
});

describe("buildResponseFormatSchema", () => {
  it("returns the supplied schema for json_schema", () => {
    const s = { type: "object", properties: { x: { type: "number" } } };
    expect(buildResponseFormatSchema({ type: "json_schema", schema: s })).toBe(s);
  });

  it("returns a permissive object schema for json_object", () => {
    expect(buildResponseFormatSchema({ type: "json_object" })).toEqual({ type: "object" });
  });
});
