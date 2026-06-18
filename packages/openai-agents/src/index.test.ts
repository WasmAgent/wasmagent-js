/**
 * @wasmagent/openai-agents tests.
 *
 * We don't depend on `@openai/agents` runtime here — the package
 * exports a structurally-typed `OpenAiAgentTool` shape, so unit tests
 * call `.execute()` directly. The structural contract (name +
 * description + parameters + execute) is what the SDK accepts at
 * `agent({ tools: […] })`.
 */

import { JsKernel, ToolRegistry } from "@wasmagent/core";
import { z } from "zod";
import { codeModeAgentTool, sandboxedJsAgentTool } from "./index.js";

describe("sandboxedJsAgentTool", () => {
  it("returns the kernel's output and logs from .execute()", async () => {
    const t = sandboxedJsAgentTool({ kernel: new JsKernel() });
    const got = await t.execute({ code: "console.log('hi'); 1 + 2" });
    expect(got.output).toBe(3);
    expect(got.logs).toContain("hi");
  });

  it("honours capability denial (fetch outside allowedHosts)", async () => {
    const t = sandboxedJsAgentTool({
      kernel: new JsKernel(),
      capabilities: { allowedHosts: ["api.example.com"] },
    });
    await expect(t.execute({ code: "fetch('https://evil.com/data')" })).rejects.toThrow(
      /CapabilityDenied/
    );
  });

  it("exposes a Zod parameters schema for the SDK to introspect", () => {
    const t = sandboxedJsAgentTool({ kernel: new JsKernel() });
    expect(t.parameters.safeParse({ code: "1+1" }).success).toBe(true);
    expect(t.parameters.safeParse({}).success).toBe(false);
  });

  it("uses caller-supplied name when given, defaults otherwise", () => {
    expect(sandboxedJsAgentTool({ kernel: new JsKernel() }).name).toBe("sandboxed_js");
    expect(sandboxedJsAgentTool({ kernel: new JsKernel(), name: "run_js" }).name).toBe("run_js");
  });
});

describe("codeModeAgentTool", () => {
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

    const t = codeModeAgentTool({ kernel: new JsKernel(), tools: reg });
    const got = await t.execute({
      code: `
        const a = await callTool("double", { n: 21 });
        return await callTool("stringify", { n: Number(a) });
      `,
    });
    expect(got.output).toContain("42");
    expect(got.toolCallCount).toBe(2);
  }, 10_000);

  it("defaults the tool name to execute_code", () => {
    const t = codeModeAgentTool({ kernel: new JsKernel(), tools: new ToolRegistry() });
    expect(t.name).toBe("execute_code");
  });
});
