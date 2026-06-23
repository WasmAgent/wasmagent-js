/**
 * ToolCallingAgent with McpToolCollection (D4 example).
 *
 * Connects to an MCP server that exposes tools, then runs a ToolCallingAgent
 * that uses those tools via native model tool_use blocks.
 *
 * Run with:
 *   ANTHROPIC_API_KEY=sk-... node mcp-agent.js
 *
 * This example uses a mock MCP server for demonstration. Replace the
 * McpToolCollection.fromStdio() call with your real MCP server command.
 */

import { ToolCallingAgent, AnthropicModel, McpToolCollection } from "@wasmagent/core";
import { z } from "zod";

// ── Option A: MCP server via stdio ────────────────────────────────────────────
// Uncomment to use a real MCP server:
//
// const tools = await McpToolCollection.fromStdio("npx", ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
//
// Or an SSE server:
// const tools = await McpToolCollection.fromSse("https://my-mcp-server.example.com/sse");

// ── Option B: manual tools (no MCP server needed for this demo) ──────────────
import { ToolRegistry } from "@wasmagent/core";

const registry = new ToolRegistry();
registry.register({
  name: "get_weather",
  description: "Get the current weather for a city",
  inputSchema: z.object({ city: z.string() }),
  outputSchema: z.string(),
  readOnly: true,
  idempotent: true,
  forward: async ({ city }) => `Sunny, 22°C in ${city}`,
});
registry.register({
  name: "get_time",
  description: "Get the current time",
  inputSchema: z.object({ timezone: z.string().optional() }),
  outputSchema: z.string(),
  readOnly: true,
  idempotent: false,
  forward: async ({ timezone }) => {
    const opts = timezone ? { timeZone: timezone } : {};
    return new Date().toLocaleTimeString("en-US", opts);
  },
});

const model = new AnthropicModel("claude-sonnet-4-6");

const agent = new ToolCallingAgent({
  tools: registry.list(),
  model,
  maxSteps: 5,
});

console.log("Starting ToolCallingAgent...\n");

for await (const event of agent.run("What's the weather in Tokyo and the current time in UTC?")) {
  switch (event.event) {
    case "tool_call": {
      const { toolName, args } = event.data;
      console.log(`→ calling ${toolName}(${JSON.stringify(args)})`);
      break;
    }
    case "tool_result": {
      const { toolName, output } = event.data;
      console.log(`← ${toolName}: ${JSON.stringify(output)}`);
      break;
    }
    case "final_answer":
      console.log("\nFinal answer:", event.data.answer);
      break;
    case "error":
      console.error("\nError:", event.data.error);
      break;
  }
}
