import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry, zodToJsonSchema } from "../tools/ToolRegistry.js";
import type { ToolDefinition } from "../tools/types.js";

const echoTool: ToolDefinition<{ message: string }, string> = {
  name: "echo",
  description: "Echoes the input message",
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.string(),
  readOnly: true,
  idempotent: true,
  forward: async ({ message }) => message,
};

describe("ToolRegistry", () => {
  it("registers and calls a tool", async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const result = await registry.call({
      toolName: "echo",
      args: { message: "hello" },
      callId: "c1",
    });
    expect(result.output).toBe("hello");
    expect(result.error).toBeUndefined();
  });

  it("returns validation error for bad args", async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const result = await registry.call({
      toolName: "echo",
      args: { message: 123 },
      callId: "c2",
    });
    expect(result.error?.code).toBe("validation_error");
  });

  it("returns error for unknown tool", async () => {
    const registry = new ToolRegistry();
    const result = await registry.call({
      toolName: "unknown",
      args: {},
      callId: "c3",
    });
    expect(result.error?.code).toBe("execution_error");
  });

  it("rejects duplicate tool registration", () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    expect(() => registry.register(echoTool)).toThrow();
  });

  it("emits JSON schema for all tools", () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const schema = registry.toJsonSchema();
    expect(schema).toHaveLength(1);
    expect(schema[0]).toMatchObject({ name: "echo" });
  });

  // D2: runtime enforcement of readOnly/idempotent
  it("rejects tool missing readOnly (D2 enforcement)", () => {
    const registry = new ToolRegistry();
    const bad = { ...echoTool, name: "bad" };
    delete (bad as Record<string, unknown>)["readOnly"];
    expect(() => registry.register(bad as ToolDefinition)).toThrow(/readOnly/);
  });

  it("rejects tool missing idempotent (D2 enforcement)", () => {
    const registry = new ToolRegistry();
    const bad = { ...echoTool, name: "bad2" };
    delete (bad as Record<string, unknown>)["idempotent"];
    expect(() => registry.register(bad as ToolDefinition)).toThrow(/idempotent/);
  });

  it("accepts tool with readOnly=false idempotent=false", () => {
    const registry = new ToolRegistry();
    const sideEffect: ToolDefinition<{ x: number }, number> = {
      name: "sideEffect",
      description: "Has side effects",
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.number(),
      readOnly: false,
      idempotent: false,
      forward: async ({ x }) => x,
    };
    expect(() => registry.register(sideEffect)).not.toThrow();
  });
});

describe("zodToJsonSchema", () => {
  it("ZodString → { type: 'string' }", () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: "string" });
  });

  it("ZodNumber → { type: 'number' }", () => {
    expect(zodToJsonSchema(z.number())).toEqual({ type: "number" });
  });

  it("ZodBoolean → { type: 'boolean' }", () => {
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: "boolean" });
  });

  it("ZodObject with required and optional fields", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().optional(),
    });
    const result = zodToJsonSchema(schema) as Record<string, unknown>;
    expect(result["type"]).toBe("object");
    const props = result["properties"] as Record<string, unknown>;
    expect(props["name"]).toEqual({ type: "string" });
    // optional field appears in properties (library may emit anyOf or plain type)
    expect(props["age"]).toBeDefined();
    expect(result["required"]).toEqual(["name"]);
  });

  it("ZodOptional emits anyOf per OpenAPI 3.0", () => {
    const result = zodToJsonSchema(z.string().optional()) as Record<string, unknown>;
    expect(result["anyOf"]).toBeDefined();
  });

  it("ZodNullable adds nullable: true", () => {
    const result = zodToJsonSchema(z.string().nullable()) as Record<string, unknown>;
    expect(result["type"]).toBe("string");
    expect(result["nullable"]).toBe(true);
  });

  it("ZodArray with typed items", () => {
    const result = zodToJsonSchema(z.array(z.string())) as Record<string, unknown>;
    expect(result["type"]).toBe("array");
    expect(result["items"]).toEqual({ type: "string" });
  });

  it("ZodArray of objects", () => {
    const result = zodToJsonSchema(z.array(z.object({ id: z.number() }))) as Record<string, unknown>;
    expect(result["type"]).toBe("array");
    expect((result["items"] as Record<string, unknown>)["type"]).toBe("object");
  });

  it("ZodEnum produces string enum", () => {
    const result = zodToJsonSchema(z.enum(["a", "b", "c"])) as Record<string, unknown>;
    expect(result["type"]).toBe("string");
    expect(result["enum"]).toEqual(["a", "b", "c"]);
  });

  it("ZodLiteral string", () => {
    const result = zodToJsonSchema(z.literal("hello")) as Record<string, unknown>;
    expect(result["type"]).toBe("string");
    // library uses enum for literals (equivalent to const per JSON Schema)
    expect(result["enum"]).toEqual(["hello"]);
  });

  it("ZodLiteral number", () => {
    const result = zodToJsonSchema(z.literal(42)) as Record<string, unknown>;
    expect(result["type"]).toBe("number");
    expect(result["enum"]).toEqual([42]);
  });

  it("ZodUnion produces anyOf", () => {
    const result = zodToJsonSchema(z.union([z.string(), z.number()])) as Record<string, unknown>;
    expect(result["anyOf"]).toHaveLength(2);
  });

  it("ZodRecord produces additionalProperties", () => {
    const result = zodToJsonSchema(z.record(z.string())) as Record<string, unknown>;
    expect(result["type"]).toBe("object");
    expect(result["additionalProperties"]).toEqual({ type: "string" });
  });

  it(".describe() passthrough", () => {
    const result = zodToJsonSchema(z.string().describe("A user name")) as Record<string, unknown>;
    expect(result["type"]).toBe("string");
    expect(result["description"]).toBe("A user name");
  });

  it("ZodDefault preserves type (library includes default value)", () => {
    const result = zodToJsonSchema(z.string().default("hello")) as Record<string, unknown>;
    expect(result["type"]).toBe("string");
  });

  it("nested ZodObject", () => {
    const schema = z.object({
      user: z.object({ id: z.number(), name: z.string() }),
    });
    const result = zodToJsonSchema(schema) as Record<string, unknown>;
    const props = result["properties"] as Record<string, unknown>;
    const userSchema = props["user"] as Record<string, unknown>;
    expect(userSchema["type"]).toBe("object");
    const userProps = userSchema["properties"] as Record<string, unknown>;
    expect(userProps["id"]).toEqual({ type: "number" });
  });
});

describe("ToolRegistry extraCapabilities (A2)", () => {
  const gateTool: ToolDefinition<{ x: number }, number> = {
    name: "gated",
    description: "Requires a special capability",
    inputSchema: z.object({ x: z.number() }),
    outputSchema: z.number(),
    readOnly: true,
    idempotent: true,
    requiredCapability: "tool:gated",
    forward: async ({ x }) => x * 10,
  };

  it("returns capability_denied when requiredCapability is absent from grantedCapabilities", async () => {
    const registry = new ToolRegistry();
    registry.register(gateTool);
    const result = await registry.call({ toolName: "gated", args: { x: 1 }, callId: "c1" });
    expect(result.error?.code).toBe("capability_denied");
    expect(result.error?.message).toContain("tool:gated");
  });

  it("returns capability_denied when grantedCapabilities list does not include the required one", async () => {
    const registry = new ToolRegistry();
    registry.register(gateTool);
    const result = await registry.call(
      { toolName: "gated", args: { x: 1 }, callId: "c2" },
      ["tool:other"]
    );
    expect(result.error?.code).toBe("capability_denied");
  });

  it("succeeds when the required capability is in grantedCapabilities", async () => {
    const registry = new ToolRegistry();
    registry.register(gateTool);
    const result = await registry.call(
      { toolName: "gated", args: { x: 5 }, callId: "c3" },
      ["tool:gated"]
    );
    expect(result.error).toBeUndefined();
    expect(result.output).toBe(50);
  });

  it("tool without requiredCapability is unaffected by grantedCapabilities", async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const result = await registry.call(
      { toolName: "echo", args: { message: "hi" }, callId: "c4" },
      ["tool:unrelated"]
    );
    expect(result.error).toBeUndefined();
    expect(result.output).toBe("hi");
  });

  it("retryHint contains the missing capability name", async () => {
    const registry = new ToolRegistry();
    registry.register(gateTool);
    const result = await registry.call({ toolName: "gated", args: { x: 1 }, callId: "c5" });
    expect(result.error?.retryHint).toContain("tool:gated");
  });
});

describe("zodToJsonSchema additional branches", () => {
  it("ZodNull → nullable type (library maps z.null() to nullable)", () => {
    const result = zodToJsonSchema(z.null()) as Record<string, unknown>;
    // library emits { enum: ["null"], nullable: true } for z.null() in openApi3 mode
    expect(result["nullable"]).toBe(true);
  });

  it("ZodAny → {} (empty schema)", () => {
    expect(zodToJsonSchema(z.any())).toEqual({});
  });

  it("ZodUnknown → {} (empty schema)", () => {
    expect(zodToJsonSchema(z.unknown())).toEqual({});
  });

  it("ZodBigInt → integer type (library uses { type: 'integer', format: 'int64' })", () => {
    const result = zodToJsonSchema(z.bigint()) as Record<string, unknown>;
    expect(result["type"]).toBe("integer");
  });

  it("ZodDiscriminatedUnion → anyOf", () => {
    const schema = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("a"), value: z.string() }),
      z.object({ kind: z.literal("b"), count: z.number() }),
    ]);
    const result = zodToJsonSchema(schema) as Record<string, unknown>;
    expect(Array.isArray(result["anyOf"])).toBe(true);
    expect((result["anyOf"] as unknown[]).length).toBe(2);
  });

  it("ZodNativeEnum → enum values array", () => {
    enum Direction { Up = "UP", Down = "DOWN" }
    const result = zodToJsonSchema(z.nativeEnum(Direction)) as Record<string, unknown>;
    expect(Array.isArray(result["enum"])).toBe(true);
    expect(result["enum"]).toContain("UP");
    expect(result["enum"]).toContain("DOWN");
  });

  it("unknown type → fallback empty schema {}", () => {
    // Simulate an unrecognised typeName by passing a raw Zod schema whose _def
    // has no matching typeName branch.
    const fakeSchema = { _def: { typeName: "ZodNeverEverKnown" } } as unknown as ReturnType<typeof z.string>;
    expect(zodToJsonSchema(fakeSchema)).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L1-1: Deferred tools excluded from toJsonSchema()
// L1-2: inputExamples surfaced in toJsonSchema()
// L1-3: allowedCallers surfaced in toJsonSchema()
// ─────────────────────────────────────────────────────────────────────────────

describe("ToolRegistry — L1 advanced tool use", () => {
  function makeTool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
    return {
      name,
      description: `${name} tool`,
      inputSchema: z.object({ q: z.string() }),
      outputSchema: z.string(),
      readOnly: true,
      idempotent: true,
      forward: async () => "ok",
      ...extra,
    };
  }

  it("L1-1: deferred tool is excluded from toJsonSchema()", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("eager_tool"));
    registry.register(makeTool("deferred_tool", { deferLoading: true }));

    const schemas = registry.toJsonSchema() as Array<Record<string, unknown>>;
    const names = schemas.map((s) => s["name"]);
    expect(names).toContain("eager_tool");
    expect(names).not.toContain("deferred_tool");
  });

  it("L1-1: toDeferredJsonSchema() returns only deferred tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("eager_tool"));
    registry.register(makeTool("deferred_tool", { deferLoading: true }));

    const deferred = registry.toDeferredJsonSchema() as Array<Record<string, unknown>>;
    expect(deferred.map((s) => s["name"])).toEqual(["deferred_tool"]);
  });

  it("L1-1: hasDeferred is false when no deferred tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("tool_a"));
    expect(registry.hasDeferred).toBe(false);
  });

  it("L1-1: hasDeferred is true when at least one deferred tool", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("tool_a", { deferLoading: true }));
    expect(registry.hasDeferred).toBe(true);
  });

  it("L1-2: inputExamples appear in toJsonSchema() output", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("search_tool", {
      inputExamples: [{ q: "example query" }],
    }));
    const schemas = registry.toJsonSchema() as Array<Record<string, unknown>>;
    const schema = schemas.find((s) => s["name"] === "search_tool");
    expect(schema?.["input_examples"]).toEqual([{ q: "example query" }]);
  });

  it("L1-2: no input_examples field when inputExamples is absent", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("plain_tool"));
    const schemas = registry.toJsonSchema() as Array<Record<string, unknown>>;
    const schema = schemas.find((s) => s["name"] === "plain_tool");
    expect(schema?.["input_examples"]).toBeUndefined();
  });

  it("L1-3: allowedCallers appear in toJsonSchema() output", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("ptc_tool", {
      allowedCallers: ["model"],
    }));
    const schemas = registry.toJsonSchema() as Array<Record<string, unknown>>;
    const schema = schemas.find((s) => s["name"] === "ptc_tool");
    expect(schema?.["allowed_callers"]).toEqual(["model"]);
  });

  it("L1-3: hasProgrammaticCallers is true when a tool has allowedCallers", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("ptc_tool", { allowedCallers: ["model"] }));
    expect(registry.hasProgrammaticCallers).toBe(true);
  });

  it("L1-3: hasProgrammaticCallers is false when no tool has allowedCallers", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("plain_tool"));
    expect(registry.hasProgrammaticCallers).toBe(false);
  });
});
