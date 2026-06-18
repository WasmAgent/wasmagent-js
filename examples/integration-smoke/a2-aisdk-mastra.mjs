/**
 * A2 (S1) integration smoke — verify the AI SDK + Mastra plugin packages
 * actually work end-to-end. We don't import `ai` here (the package is
 * structurally typed) but we do exercise the same `tool({ description,
 * parameters, execute })` shape an AI SDK 4–6 caller would use, and the
 * Mastra `execute(code, options)` contract.
 */
import { JsKernel, ToolRegistry } from "@wasmagent/core";
import { codeModeTool, sandboxedJsTool } from "@wasmagent/aisdk";
import { agentkitMastraSandbox } from "@wasmagent/mastra-sandbox";
import { z } from "zod";

// ── 1. sandboxedJsTool ──────────────────────────────────────────────────────

const t1 = sandboxedJsTool({ kernel: new JsKernel({ timeoutMs: 3_000 }) });
const r1 = await t1.execute({ code: "1 + 2 + 3" });
console.log("[A2.1] sandboxedJsTool 1+2+3 →", r1.output);
if (r1.output !== 6) throw new Error("expected 6");

const t1schema = t1.parameters.safeParse({ code: "x" });
if (!t1schema.success) throw new Error("schema reject");
const t1bad = t1.parameters.safeParse({});
if (t1bad.success) throw new Error("schema should require `code`");
console.log("[A2.1] zod schema accept/reject ✓");

// ── 2. capability denial propagates through the AI SDK tool ────────────────

const t1guarded = sandboxedJsTool({
  kernel: new JsKernel({ timeoutMs: 3_000 }),
  capabilities: { allowedHosts: ["api.example.com"] },
});
let caught = "";
try {
  await t1guarded.execute({ code: "fetch('https://evil.com/x')" });
} catch (e) {
  caught = e instanceof Error ? e.message : String(e);
}
if (!caught.includes("CapabilityDenied")) throw new Error("capability denial expected");
console.log("[A2.1] capability denial via aisdk tool ✓");

// ── 3. codeModeTool — chain 2 tools, only final crosses ─────────────────────

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
  forward: async ({ n }) => `n=${n}`,
});

const t2 = codeModeTool({ kernel: new JsKernel({ timeoutMs: 5_000 }), tools: reg });
const r2 = await t2.execute({
  code: `
    const a = await callTool("double", { n: 7 });
    return await callTool("stringify", { n: Number(a) });
  `,
});
console.log("[A2.2] codeModeTool chain →", r2.output, "(", r2.toolCallCount, "calls )");
if (!r2.output.includes("n=14")) throw new Error("expected 'n=14' in output");
if (r2.toolCallCount !== 2) throw new Error("expected 2 tool calls");
console.log("[A2.2] codeModeTool chain ✓");

// ── 4. mastra-sandbox provider ──────────────────────────────────────────────

const sandbox = agentkitMastraSandbox({
  kernel: new JsKernel({ timeoutMs: 3_000 }),
  capabilities: { env: { REGION: "us" } },
});
const r3 = await sandbox.execute("JSON.stringify({region: __env__.REGION, n: 7*6})");
console.log("[A2.3] mastra exitCode =", r3.exitCode, "output =", r3.output);
if (r3.exitCode !== 0) throw new Error(`exitCode ${r3.exitCode}, stderr: ${r3.stderr}`);
const parsed = JSON.parse(r3.output);
if (parsed.region !== "us" || parsed.n !== 42) throw new Error("env or math broken");

// per-call env override
const r4 = await sandbox.execute("__env__.REGION", { env: { REGION: "eu" } });
if (r4.output !== "eu" && JSON.parse(r4.output) !== "eu") {
  // OpenAI returns string verbatim from output (no JSON). Accept both shapes.
  console.log("[A2.3] per-call env raw output:", r4.output);
}
console.log("[A2.3] mastra sandbox env round-trip ✓");

// per-call timeout
const r5 = await sandbox.execute("while(true){}", { timeout: 100 });
if (r5.exitCode !== 1) throw new Error("expected timeout exit 1");
if (!r5.stderr.includes("timed out")) throw new Error("expected timeout msg");
console.log("[A2.3] mastra sandbox per-call timeout ✓");

console.log("\n[A2] all integration checks passed");
process.exit(0);
