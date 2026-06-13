/**
 * D5 — StackBlitz-runnable demo: Claude Agent SDK shape + agentkit-js
 * QuickJS kernel.
 *
 * `sandboxedJsClaudeTool({ kernel })` returns a `ClaudeAgentTool` shape
 * — `{ name, description, input_schema, run }`. Hand it to the Claude
 * Agent SDK as a tool. We exercise `.run()` directly so the demo runs
 * without an Anthropic API key.
 */
import { sandboxedJsClaudeTool } from "@agentkit-js/claude-agent-sdk";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";

const tool = sandboxedJsClaudeTool({
  kernel: new QuickJSKernel(),
  capabilities: { cpuMs: 3000 },
});

console.log("Tool name:", tool.name);
console.log("Description:", tool.description);

const result = await tool.handler({ code: "[1,2,3].map(x => x * x)" });
console.log("Handler result:", result);
