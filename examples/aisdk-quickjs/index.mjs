/**
 * D5 — StackBlitz-runnable demo: Vercel AI SDK + agentkit-js QuickJS kernel.
 *
 * Demonstrates the smallest possible surface: register a single sandboxed JS
 * tool, ask the model to use it. No external sandbox provider needed.
 *
 * Set OPENAI_API_KEY in your environment (or in the StackBlitz secrets pane)
 * before running.
 */
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { sandboxedJsTool } from "@agentkit-js/aisdk";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";

const kernel = new QuickJSKernel();

const result = await generateText({
  model: openai("gpt-4o-mini"),
  tools: {
    runJs: sandboxedJsTool({
      kernel,
      capabilities: { cpuMs: 3000 },
    }),
  },
  prompt: "Use runJs to compute the 12th Fibonacci number.",
});

console.log(result.text);
