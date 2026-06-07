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
    // D2: enforce explicit side-effect declarations at registration time.
    // TypeScript enforces this at compile time, but plain-JS callers bypass it.
    const toolAny = tool as unknown as Record<string, unknown>;
    if (typeof toolAny["readOnly"] !== "boolean") {
      throw new Error(
        `Tool "${tool.name}" must declare readOnly: boolean (required for C3 speculative execution)`
      );
    }
    if (typeof toolAny["idempotent"] !== "boolean") {
      throw new Error(
        `Tool "${tool.name}" must declare idempotent: boolean (required for C3/C4 caching)`
      );
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

  /** JSON schema for all tools — passed to model as tool definitions (E1).
   * Sorted by name for deterministic cache keys across registrations. */
  toJsonSchema(): object[] {
    return [...this.#tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema ? zodToJsonSchema(t.inputSchema) : {},
      }));
  }

  async call(toolCall: ToolCall, grantedCapabilities?: string[]): Promise<ToolResult> {
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

    // A2: check extraCapabilities if the tool declares a requirement.
    if (tool.requiredCapability) {
      const granted = grantedCapabilities ?? [];
      if (!granted.includes(tool.requiredCapability)) {
        return {
          callId: toolCall.callId,
          toolName: toolCall.toolName,
          output: null,
          error: {
            code: "capability_denied",
            message: `Tool "${tool.name}" requires capability "${tool.requiredCapability}" which has not been granted`,
            retryHint: `Grant the capability "${tool.requiredCapability}" in the agent's CapabilityManifest.extraCapabilities`,
          },
        };
      }
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

/**
 * Zod → JSON Schema converter (D2 — full subset for tool input schemas).
 *
 * Handles: ZodObject, ZodString, ZodNumber, ZodBoolean, ZodArray,
 *          ZodOptional, ZodNullable, ZodEnum, ZodLiteral, ZodUnion,
 *          ZodDefault (unwrap inner), plus .describe() passthrough.
 */
export function zodToJsonSchema(schema: z.ZodSchema): object {
  const def = schema._def as Record<string, unknown>;
  const typeName = def["typeName"] as string | undefined;

  // Pull description from .describe() if present (works for all types).
  const description =
    typeof def["description"] === "string" ? def["description"] : undefined;

  const withDesc = (base: Record<string, unknown>): object => {
    if (description) return { ...base, description };
    return base;
  };

  // ZodObject
  if ("shape" in def && typeof def["shape"] === "function") {
    const shape = (def["shape"] as () => Record<string, z.ZodSchema>)();
    const properties: Record<string, object> = {};
    const required: string[] = [];
    for (const [key, fieldSchema] of Object.entries(shape)) {
      const unwrapped = unwrapOptionalNullable(fieldSchema);
      properties[key] = zodToJsonSchema(fieldSchema);
      if (!(unwrapped !== fieldSchema)) {
        // field was not optional/nullable — include in required
      }
      if (!isOptionalOrNullable(fieldSchema)) {
        required.push(key);
      }
    }
    return withDesc({ type: "object", properties, ...(required.length ? { required } : {}) });
  }

  // ZodOptional / ZodNullable — unwrap and mark nullable
  if (typeName === "ZodOptional" || typeName === "ZodNullable") {
    const inner = def["innerType"] as z.ZodSchema;
    const innerSchema = zodToJsonSchema(inner) as Record<string, unknown>;
    if (typeName === "ZodNullable") {
      return withDesc({ ...innerSchema, nullable: true });
    }
    return withDesc(innerSchema);
  }

  // ZodDefault — unwrap inner, the default value is only relevant at runtime
  if (typeName === "ZodDefault") {
    const inner = def["innerType"] as z.ZodSchema;
    return zodToJsonSchema(inner);
  }

  // ZodArray
  if (typeName === "ZodArray") {
    const items = zodToJsonSchema(def["type"] as z.ZodSchema);
    return withDesc({ type: "array", items });
  }

  // ZodEnum — z.enum(["a","b","c"])
  if (typeName === "ZodEnum") {
    const values = def["values"] as string[];
    return withDesc({ type: "string", enum: values });
  }

  // ZodNativeEnum — z.nativeEnum(SomeEnum)
  if (typeName === "ZodNativeEnum") {
    const enumObj = def["values"] as Record<string, string | number>;
    const values = Object.values(enumObj);
    return withDesc({ enum: values });
  }

  // ZodLiteral
  if (typeName === "ZodLiteral") {
    const value = def["value"];
    const literalType =
      typeof value === "string" ? "string" :
      typeof value === "number" ? "number" :
      typeof value === "boolean" ? "boolean" : undefined;
    return withDesc({ ...(literalType ? { type: literalType } : {}), const: value });
  }

  // ZodUnion — anyOf
  if (typeName === "ZodUnion") {
    const options = def["options"] as z.ZodSchema[];
    return withDesc({ anyOf: options.map(zodToJsonSchema) });
  }

  // ZodDiscriminatedUnion
  if (typeName === "ZodDiscriminatedUnion") {
    const options = def["options"] as z.ZodSchema[];
    return withDesc({ anyOf: options.map(zodToJsonSchema) });
  }

  // Primitives
  if (typeName === "ZodString") return withDesc({ type: "string" });
  if (typeName === "ZodNumber" || typeName === "ZodBigInt") return withDesc({ type: "number" });
  if (typeName === "ZodBoolean") return withDesc({ type: "boolean" });
  if (typeName === "ZodNull") return withDesc({ type: "null" });
  if (typeName === "ZodAny" || typeName === "ZodUnknown") return withDesc({});
  if (typeName === "ZodRecord") {
    const valueType = zodToJsonSchema(def["valueType"] as z.ZodSchema);
    return withDesc({ type: "object", additionalProperties: valueType });
  }

  // Fallback — emit an empty schema (accepts anything)
  return withDesc({});
}

function isOptionalOrNullable(schema: z.ZodSchema): boolean {
  const typeName = (schema._def as Record<string, unknown>)["typeName"] as string;
  return typeName === "ZodOptional" || typeName === "ZodNullable" || typeName === "ZodDefault";
}

function unwrapOptionalNullable(schema: z.ZodSchema): z.ZodSchema {
  const typeName = (schema._def as Record<string, unknown>)["typeName"] as string;
  if (typeName === "ZodOptional" || typeName === "ZodNullable" || typeName === "ZodDefault") {
    return (schema._def as Record<string, unknown>)["innerType"] as z.ZodSchema;
  }
  return schema;
}
