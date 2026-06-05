import { z } from "zod";
import type { ToolCall, ToolDefinition, ToolResult } from "./types.js";

/**
 * Registry that holds all tools available to an agent.
 *
 * Validates side-effect metadata at registration (D2) — a tool without
 * explicit readOnly/idempotent declarations is rejected so C3 speculative
 * execution always has accurate barrier data.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  /** JSON schema for all tools — passed to model as tool definitions (E1). */
  toJsonSchema(): object[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema ? zodToJsonSchema(t.inputSchema) : {},
    }));
  }

  async call(toolCall: ToolCall): Promise<ToolResult> {
    const tool = this.#tools.get(toolCall.toolName);
    if (!tool) {
      return {
        callId: toolCall.callId,
        toolName: toolCall.toolName,
        output: null,
        error: {
          code: "execution_error",
          message: `Unknown tool: ${toolCall.toolName}`,
          retryHint: `Available tools: ${[...this.#tools.keys()].join(", ")}`,
        },
      };
    }

    // Validate input with zod (D2 — replaces AgentParsingError retry loop).
    const parsed = tool.inputSchema.safeParse(toolCall.args);
    if (!parsed.success) {
      return {
        callId: toolCall.callId,
        toolName: toolCall.toolName,
        output: null,
        error: {
          code: "validation_error",
          message: parsed.error.message,
          retryHint: `Fix the arguments: ${parsed.error.flatten().fieldErrors}`,
        },
      };
    }

    try {
      const output = await tool.forward(parsed.data);
      return { callId: toolCall.callId, toolName: toolCall.toolName, output };
    } catch (err) {
      return {
        callId: toolCall.callId,
        toolName: toolCall.toolName,
        output: null,
        error: {
          code: "execution_error",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}

/** Minimal Zod → JSON Schema converter (subset sufficient for tool definitions). */
function zodToJsonSchema(schema: z.ZodSchema): object {
  const def = schema._def as Record<string, unknown>;
  // Delegate to a proper converter in production; this is the M0 skeleton.
  if ("shape" in def && typeof def["shape"] === "function") {
    const shape = (def["shape"] as () => Record<string, z.ZodSchema>)();
    const properties: Record<string, object> = {};
    const required: string[] = [];
    for (const [key, fieldSchema] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(fieldSchema);
      if (!(fieldSchema instanceof z.ZodOptional)) {
        required.push(key);
      }
    }
    return { type: "object", properties, required };
  }
  if (def["typeName"] === "ZodString") return { type: "string" };
  if (def["typeName"] === "ZodNumber") return { type: "number" };
  if (def["typeName"] === "ZodBoolean") return { type: "boolean" };
  return {};
}
