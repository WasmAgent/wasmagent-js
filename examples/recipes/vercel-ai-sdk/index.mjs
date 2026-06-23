/**
 * Recipe: WasmAgent + Vercel AI SDK
 *
 * sandboxedJsTool() wraps a WasmAgent kernel as a Vercel AI SDK tool.
 * Model-generated code runs inside QuickJS-in-WASM — no node:vm needed,
 * edge-safe, isolated from the host process.
 *
 * Prerequisites:
 *   npm install @wasmagent/aisdk @wasmagent/kernel-quickjs ai @ai-sdk/openai \
 *     quickjs-emscripten @jitl/quickjs-wasmfile-release-sync
 *
 * Run:
 *   OPENAI_API_KEY=sk-... node index.mjs
 */
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { sandboxedJsTool } from "@wasmagent/aisdk";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

// One kernel instance can be reused across multiple calls.
const kernel = new QuickJSKernel();

const result = await generateText({
  model: openai("gpt-4o-mini"),
  tools: {
    runJs: sandboxedJsTool({
      kernel,
      capabilities: {
        allowedHosts: [],       // no outbound network from sandboxed code
        cpuMs: 3000,            // 3 s CPU ceiling
        memoryLimitBytes: 64 * 1024 * 1024,
      },
    }),
  },
  prompt: "Use runJs to compute the 12th Fibonacci number.",
});

console.log(result.text);
