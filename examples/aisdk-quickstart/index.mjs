/**
 * @wasmagent/aisdk quickstart — minimal Vercel AI SDK integration.
 *
 * Registers a sandboxed JS tool and asks a model to use it.
 * Set OPENAI_API_KEY before running: node index.mjs
 */
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { sandboxedJsTool } from "@wasmagent/aisdk";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const kernel = new QuickJSKernel();

const { text } = await generateText({
  model: openai("gpt-4o-mini"),
  tools: {
    runJs: sandboxedJsTool({
      kernel,
      capabilities: {
        allowedHosts: [],        // no outbound network
        allowedPaths: [],        // no filesystem access
        cpuMs: 5_000,
        memoryLimitBytes: 64 * 1024 * 1024,
      },
    }),
  },
  prompt: "Use runJs to compute the 12th Fibonacci number.",
});

console.log(text);
