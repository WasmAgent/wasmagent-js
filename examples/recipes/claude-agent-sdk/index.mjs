/**
 * Recipe: WasmAgent + Claude Agent SDK
 *
 * sandboxedJsClaudeTool() returns a ClaudeAgentTool shape:
 *   { name, description, input_schema, handler }
 * Pass it to the Claude Agent SDK as a tool, or to any transport that
 * consumes that quadruple (Bedrock, Vertex, …).
 *
 * This script exercises tool.handler() directly so it runs without an
 * Anthropic API key. See the recipe doc for the full SDK wiring snippet.
 *
 * Prerequisites:
 *   npm install @wasmagent/claude-agent-sdk @wasmagent/kernel-quickjs \
 *     @anthropic-ai/sdk quickjs-emscripten @jitl/quickjs-wasmfile-release-sync
 *
 * Run:
 *   node index.mjs
 *   ANTHROPIC_API_KEY=sk-ant-... node index.mjs  (for the SDK example in docs)
 */
import { sandboxedJsClaudeTool } from "@wasmagent/claude-agent-sdk";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const tool = sandboxedJsClaudeTool({
  kernel: new QuickJSKernel(),
  capabilities: {
    allowedHosts: [],       // no outbound network from sandboxed code
    cpuMs: 3000,            // 3 s CPU ceiling
    memoryLimitBytes: 64 * 1024 * 1024,
  },
});

// Inspect the tool shape Claude sees.
console.log("Tool name:", tool.name);
console.log("Description:", tool.description);

// Invoke directly — no API key needed to test the handler.
const result = await tool.handler({ code: "[1, 2, 3].map(x => x * x)" });
console.log("Handler result:", result);
