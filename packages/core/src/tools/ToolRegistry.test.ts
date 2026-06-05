import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../tools/ToolRegistry.js";
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
});
