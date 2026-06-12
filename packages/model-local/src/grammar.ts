/**
 * Grammar / structured-output helpers for local llama.cpp models.
 *
 * The job of this module: take an agent's `tools: ToolDefinition[]` (or a
 * GenerateOptions.responseFormat) and produce
 *
 *   1. a JSON Schema describing the legal output, and
 *   2. a system-prompt addendum telling the model what shape it must emit,
 *
 * which the {@link LocalModel} then hands to node-llama-cpp's grammar-
 * constrained sampler. The grammar guarantees *form* (legal JSON matching
 * the schema); the prompt addendum nudges the model toward *correct* fills.
 *
 * Notes:
 *   - We deliberately do NOT compile GBNF here — node-llama-cpp does that
 *     internally given a JSON Schema, and the project warns its GBNF API
 *     surface may evolve. Keeping the boundary at JSON Schema means we
 *     ride along with whichever grammar engine ships in node-llama-cpp.
 *   - `tools` arrives as `object[]` from GenerateOptions for historical
 *     reasons (the OpenAI/Anthropic adapters accept whatever the SDK wants).
 *     We accept the same loose shape and best-effort-extract `name` /
 *     `description` / `input_schema` fields.
 */

// Loose tool shape — matches both the OpenAI tools array and the Anthropic
// raw `{name, description, input_schema}` objects that core agents pass.
export interface ExtractedTool {
  name: string;
  description?: string;
  inputSchema: object;
}

/** Best-effort extraction from the heterogeneous `tools: object[]` slot. */
export function extractTools(tools: object[] | undefined): ExtractedTool[] {
  if (!tools) return [];
  const out: ExtractedTool[] = [];
  for (const raw of tools) {
    const t = raw as Record<string, unknown>;
    // Anthropic shape: {name, description, input_schema}
    if (typeof t.name === "string" && (t.input_schema || t.inputSchema)) {
      out.push({
        name: t.name,
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        inputSchema: (t.input_schema ?? t.inputSchema) as object,
      });
      continue;
    }
    // OpenAI shape: {type:"function", function:{name, description, parameters}}
    if (t.type === "function" && t.function) {
      const fn = t.function as Record<string, unknown>;
      if (typeof fn.name === "string" && fn.parameters) {
        out.push({
          name: fn.name,
          ...(typeof fn.description === "string" ? { description: fn.description } : {}),
          inputSchema: fn.parameters as object,
        });
      }
    }
  }
  return out;
}

/**
 * Build a JSON Schema describing the expected tool-call output:
 * either a final text answer, or a tool invocation chosen from the supplied
 * list. Mirrors the Anthropic `tool_use` block shape so the parser in
 * {@link parseToolCallOutput} can produce a {@link ToolUseBlock} verbatim.
 */
export function buildToolCallSchema(tools: ExtractedTool[]): object {
  const toolBranches = tools.map((t) => ({
    type: "object",
    additionalProperties: false,
    required: ["type", "name", "input"],
    properties: {
      type: { type: "string", const: "tool_use" },
      name: { type: "string", const: t.name },
      input: t.inputSchema,
    },
  }));

  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["type", "text"],
        properties: {
          type: { type: "string", const: "final_answer" },
          text: { type: "string" },
        },
      },
      ...toolBranches,
    ],
  };
}

/**
 * Build a compact system-prompt addendum advertising the tools and the
 * required JSON shape. Kept short so it fits inside small models'
 * effective-attention windows.
 */
export function buildToolPromptAddendum(tools: ExtractedTool[]): string {
  if (tools.length === 0) return "";
  const lines: string[] = [];
  lines.push(
    "You can either return a final answer or call exactly one tool.",
    "Output ONLY a JSON object — no prose, no markdown, no backticks.",
    "",
    "Final answer schema:",
    `  {"type":"final_answer","text":"..."}`,
    "",
    "Tool call schema (pick one tool):",
    `  {"type":"tool_use","name":"<tool>","input":{...}}`,
    "",
    "Available tools:"
  );
  for (const t of tools) {
    const desc = t.description ? ` — ${t.description}` : "";
    lines.push(`- ${t.name}${desc}`);
    lines.push(`  input schema: ${JSON.stringify(t.inputSchema)}`);
  }
  return lines.join("\n");
}

export interface ParsedToolCallOutput {
  /** Either a final answer or a tool invocation; mutually exclusive. */
  finalAnswer?: string;
  toolCall?: { name: string; input: Record<string, unknown> };
  /** Set when the JSON parsed but didn't match either branch. */
  parseError?: string;
}

/**
 * Parse a model's grammar-constrained output. Tolerates leading/trailing
 * whitespace and common "stray newline after closing brace" artifacts. Any
 * structural mismatch → `parseError` so callers can surface a typed error.
 */
export function parseToolCallOutput(raw: string): ParsedToolCallOutput {
  const trimmed = raw.trim();
  if (!trimmed) return { parseError: "empty output" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { parseError: `invalid JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { parseError: "top-level JSON must be an object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type === "final_answer" && typeof obj.text === "string") {
    return { finalAnswer: obj.text };
  }
  if (
    obj.type === "tool_use" &&
    typeof obj.name === "string" &&
    typeof obj.input === "object" &&
    obj.input !== null
  ) {
    return { toolCall: { name: obj.name, input: obj.input as Record<string, unknown> } };
  }
  return { parseError: `output did not match tool_use or final_answer shape: ${trimmed}` };
}

/**
 * Build a JSON Schema for an arbitrary `responseFormat: {type:"json_schema"}`.
 * The schema is forwarded verbatim — node-llama-cpp will reject schemas it
 * cannot grammar-encode, in which case the LocalModel falls back to free-form
 * sampling and surfaces the failure as a typed error.
 */
export function buildResponseFormatSchema(
  format: { type: "json_object" } | { type: "json_schema"; schema: object }
): object {
  if (format.type === "json_object") {
    // No schema → just any object.
    return { type: "object" };
  }
  return format.schema;
}
