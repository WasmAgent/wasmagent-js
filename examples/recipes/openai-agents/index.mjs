/**
 * Recipe: WasmAgent + OpenAI Agents JS SDK
 *
 * sandboxedJsAgentTool() returns the Tool shape the OpenAI Agents JS SDK
 * expects: { name, description, parameters, execute }. The execute handler
 * runs code in a sandboxed WasmAgent kernel rather than in the host process.
 *
 * This script exercises tool.execute() directly so it runs without an API key.
 * To use with a real Agent, pass the tool to: new Agent({ tools: [tool] }).
 *
 * Prerequisites:
 *   npm install @wasmagent/openai-agents @wasmagent/kernel-quickjs \
 *     @openai/agents quickjs-emscripten @jitl/quickjs-wasmfile-release-sync
 *
 * Run:
 *   node index.mjs
 *   OPENAI_API_KEY=sk-... node index.mjs  (for the Agent example below)
 */
import { sandboxedJsAgentTool } from "@wasmagent/openai-agents";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const tool = sandboxedJsAgentTool({
  kernel: new QuickJSKernel(),
  capabilities: {
    allowedHosts: [],       // no outbound network from sandboxed code
    cpuMs: 3000,            // 3 s CPU ceiling
    memoryLimitBytes: 64 * 1024 * 1024,
  },
});

// Invoke directly — no Agent loop required to test the sandbox.
console.log("Tool name:", tool.name);
const out = await tool.execute({ code: "'hello-from-quickjs'" });
console.log("Execute result:", out);
