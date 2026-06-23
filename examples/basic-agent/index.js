/**
 * Basic agent example — CodeAgent with JS kernel (default).
 *
 * Run with: ANTHROPIC_API_KEY=sk-... node index.js
 *
 * For the Pyodide (Python) kernel variant, see the comment at the bottom.
 */

import { CodeAgent, AnthropicModel } from "@wasmagent/core";
import { z } from "zod";

// 1. Define a tool.
const calculator = {
  name: "calculator",
  description: "Evaluates a simple arithmetic expression",
  inputSchema: z.object({ expression: z.string() }),
  outputSchema: z.string(),
  readOnly: true,
  idempotent: true,
  forward: async ({ expression }) => {
    const result = Function(`"use strict"; return (${expression})`)();
    return String(result);
  },
};

// 2. Create a model.
const model = new AnthropicModel("claude-sonnet-4-6");

// 3. Create the agent (JS kernel — default).
const agent = new CodeAgent({
  tools: [calculator],
  model,
  maxSteps: 5,
});

// 4. Run and stream events.
console.log("Starting agent (JS kernel)...\n");
for await (const event of agent.run("Calculate (123 * 456) + 789")) {
  if (event.event === "final_answer") {
    console.log("Answer:", event.data.answer);
  } else if (event.event === "error") {
    console.error("Error:", event.data.error);
  }
}

/*
 * ── Pyodide (Python) kernel variant ──────────────────────────────────────────
 *
 * Swap the agent construction above for:
 *
 *   const agent = new CodeAgent({
 *     tools: [calculator],
 *     model,
 *     maxSteps: 5,
 *     actionLanguage: "pyodide",   // runs Python via CPython-in-WASM
 *   });
 *
 * The agent will then execute Python code blocks:
 *   for await (const event of agent.run("Compute sum([1,2,3,4,5])")) { ... }
 *
 * Pyodide loads on first run (~300 ms). State persists across steps.
 * Requires: pnpm add pyodide   (already in peer deps)
 */
