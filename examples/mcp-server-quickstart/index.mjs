/**
 * @wasmagent/mcp-server quickstart — minimal sandboxed MCP server.
 *
 * Demonstrates createCodeModeServer() as a drop-in replacement for
 * publishing tools directly to the MCP host. The host sees only
 * docs_search + execute_code; the model dispatches to downstream
 * tools via callTool() inside sandboxed scripts.
 *
 * Run in stdio mode (for Claude Desktop / Cursor):
 *   node index.mjs --stdio
 *
 * Or run the in-process demo (no API key needed):
 *   node index.mjs
 */
import { createCodeModeServer } from "@wasmagent/mcp-server";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { ToolRegistry } from "@wasmagent/core";
import { z } from "zod";

// Register downstream tools (swap for your real tools)
const tools = new ToolRegistry();
tools.register({
  name: "add",
  description: "Add two numbers.",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  outputSchema: z.number(),
  readOnly: true,
  idempotent: true,
  forward: async ({ a, b }) => a + b,
});

const server = createCodeModeServer({
  tools,
  kernel: new QuickJSKernel(),
  capabilities: {
    allowedHosts: [],        // no outbound network
    allowedPaths: [],        // no filesystem access
    cpuMs: 5_000,
    memoryLimitBytes: 64 * 1024 * 1024,
  },
  serverInfo: { name: "mcp-server-quickstart", version: "0.1.0" },
});

// ── stdio mode ───────────────────────────────────────────────────────────────
if (process.argv.includes("--stdio")) {
  const { runStdio } = await import("@wasmagent/mcp-server/stdio");
  await runStdio(server);
  process.exit(0);
}

// ── In-process demo (no transport needed) ───────────────────────────────────
async function rpc(method, params) {
  return server.handle({ jsonrpc: "2.0", id: 1, method, params });
}

const list = await rpc("tools/list");
console.log(
  "Exposed tools:",
  list.response.result.tools.map((t) => t.name),
);
// → [ 'docs_search', 'execute_code' ]

const created = await rpc("tools/call", {
  name: "execute_code",
  arguments: { code: "await callTool('add', { a: 3, b: 4 })" },
});

const taskId = created.taskId;
let state = "pending";
let result;
let error;
for (let i = 0; i < 50 && state !== "complete" && state !== "failed"; i++) {
  await new Promise((r) => setTimeout(r, 25));
  const got = await rpc("tasks/get", { id: taskId });
  ({ state, result, error } = got.response.result);
}
console.log("execute_code →", state, "result:", result, "error:", error);
// → execute_code → complete result: 7
