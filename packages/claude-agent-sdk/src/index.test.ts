/**
 * @wasmagent/claude-agent-sdk tests.
 *
 * We don't depend on `@anthropic-ai/sdk` at runtime — the package
 * exports the structurally-typed `ClaudeAgentTool` quadruple, so unit
 * tests call `.handler()` directly. The structural contract (name +
 * description + input_schema + handler) is the wire shape every
 * Anthropic SDK current and near-future agrees on; the test pins it.
 */

import { JsKernel, ToolRegistry } from "@wasmagent/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { codeModeClaudeTool, sandboxedJsClaudeTool } from "./index.js";

describe("sandboxedJsClaudeTool", () => {
  it("returns the kernel's output and logs from .handler()", async () => {
    const t = sandboxedJsClaudeTool({ kernel: new JsKernel() });
    const got = (await t.handler({ code: "console.log('hi'); 1 + 2" })) as {
      output: unknown;
      logs: string[];
    };
    expect(got.output).toBe(3);
    expect(got.logs).toContain("hi");
  });

  it("honours capability denial (fetch outside allowedHosts)", async () => {
    const t = sandboxedJsClaudeTool({
      kernel: new JsKernel(),
      capabilities: { allowedHosts: ["api.example.com"] },
    });
    await expect(t.handler({ code: "fetch('https://evil.com/data')" })).rejects.toThrow(
      /CapabilityDenied/
    );
  });

  it("exposes a JSON Schema input_schema with required `code`", () => {
    const t = sandboxedJsClaudeTool({ kernel: new JsKernel() });
    expect(t.input_schema.type).toBe("object");
    expect(t.input_schema.required).toContain("code");
    expect((t.input_schema.properties.code as { type: string }).type).toBe("string");
  });

  it("uses caller-supplied name when given", () => {
    const t = sandboxedJsClaudeTool({ kernel: new JsKernel(), name: "run_js" });
    expect(t.name).toBe("run_js");
  });

  it("defaults the tool name to sandboxed_js", () => {
    const t = sandboxedJsClaudeTool({ kernel: new JsKernel() });
    expect(t.name).toBe("sandboxed_js");
  });
});

describe("codeModeClaudeTool", () => {
  it("runs a script that chains tools and returns only the final value", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "double",
      description: "Double a number.",
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.number(),
      readOnly: true,
      idempotent: true,
      forward: async ({ n }) => n * 2,
    });
    reg.register({
      name: "stringify",
      description: "Stringify a number.",
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.string(),
      readOnly: true,
      idempotent: true,
      forward: async ({ n }) => String(n),
    });

    const t = codeModeClaudeTool({ kernel: new JsKernel(), tools: reg });
    const got = (await t.handler({
      code: `
        const a = await callTool("double", { n: 21 });
        return await callTool("stringify", { n: Number(a) });
      `,
    })) as { output: string; toolCallCount: number };
    expect(got.output).toContain("42");
    expect(got.toolCallCount).toBe(2);
  }, 10_000);

  it("defaults the tool name to execute_code", () => {
    const t = codeModeClaudeTool({ kernel: new JsKernel(), tools: new ToolRegistry() });
    expect(t.name).toBe("execute_code");
  });
});
