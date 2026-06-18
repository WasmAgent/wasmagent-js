/**
 * @wasmagent/aisdk tests.
 *
 * We don't depend on the `ai` runtime here — the package exports a
 * structurally-typed `tool()`-shaped object, so unit tests can call
 * `.execute()` directly. The structural contract (description / parameters /
 * execute) is what AI SDK majors 4–6 all agree on; the test pins it.
 */

import { JsKernel, ToolRegistry } from "@wasmagent/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { codeModeTool, sandboxedJsTool } from "./index.js";

describe("sandboxedJsTool", () => {
  it("returns the kernel's output and logs", async () => {
    const t = sandboxedJsTool({ kernel: new JsKernel() });
    const got = await t.execute({ code: "console.log('hi'); 1 + 2" });
    expect(got.output).toBe(3);
    expect(got.logs).toContain("hi");
  });

  it("honours capability denial (fetch outside allowedHosts)", async () => {
    const t = sandboxedJsTool({
      kernel: new JsKernel(),
      capabilities: { allowedHosts: ["api.example.com"] },
    });
    await expect(t.execute({ code: "fetch('https://evil.com/data')" })).rejects.toThrow(
      /CapabilityDenied/
    );
  });

  it("exposes a sane Zod parameters schema for the AI SDK to introspect", () => {
    const t = sandboxedJsTool({ kernel: new JsKernel() });
    expect(t.parameters.safeParse({ code: "1+1" }).success).toBe(true);
    expect(t.parameters.safeParse({}).success).toBe(false);
  });
});

describe("codeModeTool", () => {
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

    const t = codeModeTool({ kernel: new JsKernel(), tools: reg });
    const got = await t.execute({
      code: `
        const a = await callTool("double", { n: 21 });
        return await callTool("stringify", { n: Number(a) });
      `,
    });
    expect(got.output).toContain("42");
    expect(got.toolCallCount).toBe(2);
  }, 10_000);
});
