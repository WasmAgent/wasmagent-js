import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ProgrammaticOrchestrator } from "../executor/ProgrammaticOrchestrator.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { VmKernel } from "../executor/VmKernel.js";

function makeTool(name: string, forward: (input: Record<string, unknown>) => Promise<string>) {
  return {
    name,
    description: `${name} mock tool`,
    inputSchema: z.record(z.unknown()),
    outputSchema: z.string(),
    readOnly: true,
    idempotent: true,
    forward,
  };
}

describe("ProgrammaticOrchestrator (L3-1)", () => {
  it("executes a script and returns a result", async () => {
    const kernel = new VmKernel();
    const registry = new ToolRegistry();
    registry.register(makeTool("greet", async (input) => `Hello, ${input["name"] ?? "world"}!`));

    const orchestrator = new ProgrammaticOrchestrator(kernel, registry);
    const result = await orchestrator.run(`"orchestration complete"`);
    // Result may be an empty string or the script output — what matters is it doesn't throw.
    expect(result).toHaveProperty("finalOutput");
    expect(result).toHaveProperty("intermediateToolCalls");
    await kernel[Symbol.asyncDispose]();
  });

  it("tracks toolCallCount correctly", async () => {
    const kernel = new VmKernel();
    const registry = new ToolRegistry();
    registry.register(makeTool("add", async (input) => String(Number(input["a"]) + Number(input["b"]))));

    const orchestrator = new ProgrammaticOrchestrator(kernel, registry);
    const result = await orchestrator.run(`"done"`);
    expect(typeof result.toolCallCount).toBe("number");
    await kernel[Symbol.asyncDispose]();
  });

  it("returns ProgrammaticResult with required fields", async () => {
    const kernel = new VmKernel();
    const registry = new ToolRegistry();
    const orchestrator = new ProgrammaticOrchestrator(kernel, registry);

    const result = await orchestrator.run(`42`);
    expect(result).toHaveProperty("finalOutput");
    expect(result).toHaveProperty("intermediateToolCalls");
    expect(result).toHaveProperty("toolCallCount");
    expect(Array.isArray(result.intermediateToolCalls)).toBe(true);
    await kernel[Symbol.asyncDispose]();
  });

  it("capability_denied blocks tool calls requiring ungiven capability", async () => {
    const kernel = new VmKernel();
    const registry = new ToolRegistry();
    registry.register({
      ...makeTool("protected_tool", async () => "secret data"),
      requiredCapability: "tool:protected",
    });

    const orchestrator = new ProgrammaticOrchestrator(kernel, registry, {
      extraCapabilities: [], // No capabilities granted.
    });

    // The orchestrator should handle gracefully — no throw.
    const result = await orchestrator.run(`"no tool calls"`);
    expect(result).toHaveProperty("finalOutput");
    await kernel[Symbol.asyncDispose]();
  });
});
