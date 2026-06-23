import { zodToJsonSchema as zodToJsonSchemaLib } from "zod-to-json-schema";
import type { AgentPrincipal, ToolCall, ToolDefinition, ToolResult } from "./types.js";

/**
 * Walk a JSON Schema tree and rewrite draft-04-style boolean
 * `exclusiveMinimum` / `exclusiveMaximum` into draft 2020-12 numeric form.
 *
 * Why: zod-to-json-schema's `target: "openApi3"` emits the draft-04 shape
 * (`{ minimum: 0, exclusiveMinimum: true }`) for `.positive()` / `.gt()` /
 * `.negative()` / `.lt()`. Anthropic's API validates against draft 2020-12
 * and rejects boolean exclusiveMinimum with HTTP 400 "tools.N.custom.input_schema:
 * JSON schema is invalid". Rather than forbid `.positive()` everywhere, we
 * canonicalise the output here so any consumer is safe by default.
 */
function normaliseExclusiveBounds(node: unknown): unknown {
  if (Array.isArray(node)) {
    for (const item of node) normaliseExclusiveBounds(item);
    return node;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj.exclusiveMinimum === true && typeof obj.minimum === "number") {
      obj.exclusiveMinimum = obj.minimum;
      delete obj.minimum;
    } else if (obj.exclusiveMinimum === false) {
      // false is the default; just drop it.
      delete obj.exclusiveMinimum;
    }
    if (obj.exclusiveMaximum === true && typeof obj.maximum === "number") {
      obj.exclusiveMaximum = obj.maximum;
      delete obj.maximum;
    } else if (obj.exclusiveMaximum === false) {
      delete obj.exclusiveMaximum;
    }
    for (const v of Object.values(obj)) normaliseExclusiveBounds(v);
  }
  return node;
}

/** Converts a Zod schema to a JSON Schema object (OpenAPI 3.0 compatible). */
export function zodToJsonSchema(schema: import("zod").ZodSchema): object {
  const raw = zodToJsonSchemaLib(schema, { target: "openApi3", $refStrategy: "none" });
  return normaliseExclusiveBounds(raw) as object;
}

/**
 * Convert a Zod schema to an OpenAI strict-mode compatible JSON Schema.
 *
 * OpenAI strict requirements (2026):
 *  - Every object must have additionalProperties: false
 *  - All properties must appear in required[]
 *  - Optional fields become anyOf: [T, {type: "null"}]
 *  - No default values
 *  - Root must be an object
 *  - Max 5 levels of nesting
 *
 * @throws Error when nesting depth exceeds 5
 */
export function toStrictJsonSchema(schema: import("zod").ZodSchema): object {
  const base = zodToJsonSchemaLib(schema, { target: "openApi3", $refStrategy: "none" }) as Record<
    string,
    unknown
  >;
  return strictifySchema(base, 0);
}

function strictifySchema(schema: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth > 5) {
    throw new Error(
      `[toStrictJsonSchema] Schema nesting depth exceeds 5 levels, which OpenAI strict mode does not support. ` +
        `Flatten your schema or remove optional wrappers.`
    );
  }
  const result: Record<string, unknown> = { ...schema };

  // Recurse into array items
  if (result.type === "array" && result.items && typeof result.items === "object") {
    result.items = strictifySchema(result.items as Record<string, unknown>, depth + 1);
  }

  // Recurse into allOf/anyOf/oneOf members
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as Record<string, unknown>[]).map((s) =>
        strictifySchema(s, depth + 1)
      );
    }
  }

  if (
    result.type !== "object" ||
    typeof result.properties !== "object" ||
    result.properties === null
  ) {
    // Remove defaults at every level
    delete result.default;
    return result;
  }

  const props = result.properties as Record<string, Record<string, unknown>>;
  const existingRequired = Array.isArray(result.required) ? (result.required as string[]) : [];
  const existingRequiredSet = new Set(existingRequired);

  const newProps: Record<string, Record<string, unknown>> = {};
  const allKeys = Object.keys(props);

  for (const key of allKeys) {
    const propSchema = props[key] as Record<string, unknown>;
    const isOptional = !existingRequiredSet.has(key);

    let strictProp = strictifySchema(propSchema, depth + 1);
    delete (strictProp as Record<string, unknown>).default;

    // Optional fields: wrap in anyOf: [original, {type:"null"}]
    if (isOptional) {
      // Avoid double-wrapping if already nullable
      const alreadyNullable =
        Array.isArray(strictProp.anyOf) &&
        (strictProp.anyOf as Record<string, unknown>[]).some((s) => s.type === "null");
      if (!alreadyNullable) {
        strictProp = { anyOf: [strictProp, { type: "null" }] };
      }
    }
    newProps[key] = strictProp;
  }

  result.properties = newProps;
  result.required = allKeys; // ALL keys go into required[]
  result.additionalProperties = false;
  delete result.default;

  return result;
}

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
    if (typeof toolAny.readOnly !== "boolean") {
      throw new Error(
        `Tool "${tool.name}" must declare readOnly: boolean (required for C3 speculative execution)`
      );
    }
    if (typeof toolAny.idempotent !== "boolean") {
      throw new Error(
        `Tool "${tool.name}" must declare idempotent: boolean (required for C3/C4 caching)`
      );
    }
    if (
      !toolAny.inputSchema ||
      typeof (toolAny.inputSchema as Record<string, unknown>).safeParse !== "function"
    ) {
      throw new Error(`Tool "${tool.name}" must declare a Zod inputSchema with a safeParse method`);
    }
    this.#tools.set(tool.name, tool);
    // A2: deferLoading and inputExamples are mutually exclusive — the Tool Search
    // API does not accept input_examples on deferred tools (see Anthropic docs 2026-03).
    const toolAny2 = tool as unknown as Record<string, unknown>;
    if (
      toolAny2.deferLoading === true &&
      Array.isArray(toolAny2.inputExamples) &&
      (toolAny2.inputExamples as unknown[]).length > 0
    ) {
      throw new Error(
        `Tool "${tool.name}" has both deferLoading:true and inputExamples, which are mutually exclusive. ` +
          `Tool Search does not support input_examples on deferred tools.`
      );
    }
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  /** Returns registered tool names in insertion order. */
  names(): string[] {
    return [...this.#tools.keys()];
  }

  /**
   * Returns the number of registered tools.
   */
  size(): number {
    return this.#tools.size;
  }

  /**
   * Resolve the alternative tools the framework should suggest when
   * `name`'s `forward()` failed. Reads `tool.alternatives` (a list of
   * tool names declared on the failed tool itself), drops dangling
   * names that don't resolve in this registry (fail-closed), and
   * returns the matching `ToolDefinition`s in declared order.
   *
   * Returns an empty array when:
   * - the failed tool is not registered (e.g. transient unregistration);
   * - the failed tool has no `alternatives` field;
   * - none of the named alternatives resolve in this registry.
   *
   * Caller (the agent loop) is responsible for capping the surfaced
   * set, deduping across turns, and rendering the prompt insertion.
   * The registry stays a pure data structure.
   */
  fallbacksFor(name: string): ToolDefinition[] {
    const tool = this.#tools.get(name);
    if (!tool?.alternatives?.length) return [];
    const out: ToolDefinition[] = [];
    for (const altName of tool.alternatives) {
      const alt = this.#tools.get(altName);
      if (alt) out.push(alt);
    }
    return out;
  }

  /**
   * JSON schema for all non-deferred tools — passed to model as tool definitions.
   * Deferred tools (deferLoading: true) are excluded; they are loaded on-demand.
   * Sorted by name for deterministic cache keys across registrations.
   *
   * @param opts.compact — when true, use `descriptionCompressed` instead of
   *   `description` when available. Useful for deferred/search contexts where
   *   token budget is tight.
   */
  toJsonSchema(opts?: { compact?: boolean }): object[] {
    const compact = opts?.compact ?? false;
    return [...this.#tools.values()]
      .filter((t) => !t.deferLoading)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => {
        const desc = compact && t.descriptionCompressed ? t.descriptionCompressed : t.description;
        const schema: Record<string, unknown> = {
          name: t.name,
          description: desc,
          input_schema:
            t.rawInputJsonSchema ?? (t.inputSchema ? zodToJsonSchema(t.inputSchema) : {}),
        };
        // L1-2: include few-shot examples when provided.
        if (t.inputExamples && t.inputExamples.length > 0) {
          schema.input_examples = t.inputExamples;
        }
        // L1-3: include allowed_callers for PTC when provided.
        if (t.allowedCallers && t.allowedCallers.length > 0) {
          schema.allowed_callers = t.allowedCallers;
        }
        return schema;
      });
  }

  /**
   * L1-1: JSON schema for deferred tools only.
   * Used by AnthropicModel to inject tool_search_tool_regex when deferLoading tools exist.
   * Always uses compact description when available — deferred tool search results are
   * the primary token-constrained context.
   */
  toDeferredJsonSchema(): object[] {
    return [...this.#tools.values()]
      .filter((t) => t.deferLoading)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        description: t.descriptionCompressed ?? t.description,
        input_schema: t.rawInputJsonSchema ?? (t.inputSchema ? zodToJsonSchema(t.inputSchema) : {}),
      }));
  }

  /** True when any registered tool has deferLoading: true. */
  get hasDeferred(): boolean {
    return [...this.#tools.values()].some((t) => t.deferLoading);
  }

  /** True when any registered tool has allowedCallers set (PTC mode). */
  get hasProgrammaticCallers(): boolean {
    return [...this.#tools.values()].some((t) => t.allowedCallers && t.allowedCallers.length > 0);
  }

  async call(
    toolCall: ToolCall,
    grantedCapabilities?: string[],
    principal?: AgentPrincipal
  ): Promise<ToolResult> {
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

    // B2: least-agency write gate — !readOnly tools with writeScope require principal authorization.
    if (!tool.readOnly && tool.writeScope && tool.writeScope.length > 0) {
      const principalScopes = principal?.grantedScopes ?? [];
      const missing = tool.writeScope.filter((s) => !principalScopes.includes(s));
      if (missing.length > 0) {
        return {
          callId: toolCall.callId,
          toolName: toolCall.toolName,
          output: null,
          error: {
            code: "capability_denied",
            message: `Tool "${tool.name}" requires write scopes [${missing.join(", ")}] not granted to principal "${principal?.id ?? "(anonymous)"}"`,
            retryHint: `Grant scopes [${missing.join(", ")}] to the AgentPrincipal or add needsApproval to request human approval`,
          },
        };
      }
    }

    // Validate input with zod (D2 — replaces AgentParsingError retry loop).
    const parsed = tool.inputSchema.safeParse(toolCall.args);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const missingFields = Object.keys(fieldErrors).join(", ");
      return {
        callId: toolCall.callId,
        toolName: toolCall.toolName,
        output: null,
        error: {
          code: "validation_error",
          message:
            `Tool "${toolCall.toolName}" called with missing/invalid arguments. Required fields: ${missingFields}. ` +
            `Fix: call ${toolCall.toolName} again with all required arguments filled in. ` +
            `Details: ${JSON.stringify(fieldErrors)}`,
          retryHint: `Call ${toolCall.toolName} again with all required arguments: ${missingFields}`,
        },
      };
    }

    try {
      const rawOutput = await tool.forward(parsed.data, toolCall.signal);
      // B1: apply sanitizeToolResult hook for untrusted tools.
      let output: unknown = rawOutput;
      if (tool.trust === "untrusted" && tool.sanitizeToolResult && typeof rawOutput === "string") {
        output = await tool.sanitizeToolResult(rawOutput, {
          toolName: toolCall.toolName,
          callId: toolCall.callId,
          input: parsed.data,
        });
      }
      // C3: apply toModelOutput compression hook if provided.
      if (tool.toModelOutput) {
        output = tool.toModelOutput(rawOutput as never);
      }
      return {
        callId: toolCall.callId,
        toolName: toolCall.toolName,
        output,
        ...(tool.trust === "untrusted" ? { trust: "untrusted" as const } : {}),
      };
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
