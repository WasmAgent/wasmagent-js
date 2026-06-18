/**
 * D5 — StackBlitz-runnable demo: OpenAI Agents JS shape + agentkit-js
 * QuickJS kernel.
 *
 * `sandboxedJsAgentTool({ kernel })` returns the `Tool` shape the OpenAI
 * Agents JS SDK uses. Exercises `.invoke()` directly so the demo runs
 * without an API key.
 */
import { sandboxedJsAgentTool } from "@wasmagent/openai-agents";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const tool = sandboxedJsAgentTool({
  kernel: new QuickJSKernel(),
  capabilities: { cpuMs: 3000 },
});

console.log("Tool name:", tool.name);
const out = await tool.execute({ code: "'hello-from-quickjs'" });
console.log("Execute result:", out);
