/**
 * Basic agent example — D5 "5-line quickstart" target.
 *
 * Demonstrates CodeAgent with a simple tool and Anthropic model.
 * Run with: ANTHROPIC_API_KEY=sk-... node index.js
 */

import { CodeAgent, AnthropicModel, ToolRegistry } from "@agentkit-js/core";
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
    // Safe eval of arithmetic only.
    const result = Function(`"use strict"; return (${expression})`)();
    return String(result);
  },
};

// 2. Create a model.
const model = new AnthropicModel("claude-sonnet-4-6");

// 3. Create the agent.
const agent = new CodeAgent({
  tools: [calculator],
  model,
  maxSteps: 5,
});

// 4. Run and stream events.
console.log("Starting agent...\n");
for await (const event of agent.run("Calculate (123 * 456) + 789")) {
  if (event.event === "final_answer") {
    console.log("Answer:", event.data.answer);
  } else if (event.event === "error") {
    console.error("Error:", event.data.error);
  }
}
