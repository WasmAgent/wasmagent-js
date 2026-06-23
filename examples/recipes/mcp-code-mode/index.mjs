/**
 * Recipe: WasmAgent MCP code-mode portal
 *
 * createPortalServer() federates multiple tool registries behind two MCP
 * tools — docs_search and execute_code — so the MCP host (Claude Code,
 * Cursor, …) always sees a fixed, small prompt regardless of how many
 * upstream tools are registered.
 *
 * Sources in this example:
 *   fs     — filesystem-like (read_file / list_dir)
 *   github — GitHub-like (list_repos / create_issue)
 *   memory — WasmAgent's built-in cross-session memory tool
 *
 * This script drives the portal in-process via its JSON-RPC handler.
 * No network access is needed.
 *
 * Prerequisites:
 *   npm install @wasmagent/core @wasmagent/mcp-server zod
 *
 * Run:
 *   node index.mjs
 */
import { JsKernel, ToolRegistry, MapKvBackend, createMemoryTool } from "@wasmagent/core";
import { createPortalServer } from "@wasmagent/mcp-server";
import { z } from "zod";

// Upstream A: filesystem-like registry.
const fs = new ToolRegistry();
fs.register({
  name: "read_file",
  description: "Read a UTF-8 file from the workspace.",
  inputSchema: z.object({ path: z.string() }),
  outputSchema: z.string(),
  readOnly: true,
  idempotent: true,
  forward: async ({ path }) => `<contents of ${path}>`,
});
fs.register({
  name: "list_dir",
  description: "List the entries of a directory.",
  inputSchema: z.object({ path: z.string() }),
  outputSchema: z.array(z.string()),
  readOnly: true,
  idempotent: true,
  forward: async ({ path }) => [`${path}/README.md`, `${path}/package.json`],
});

// Upstream B: GitHub-like registry.
const github = new ToolRegistry();
github.register({
  name: "list_repos",
  description: "List repositories in an org.",
  inputSchema: z.object({ org: z.string() }),
  outputSchema: z.array(z.string()),
  readOnly: true,
  idempotent: true,
  forward: async ({ org }) => [`${org}/wasmagent-js`],
});

// Upstream C: WasmAgent built-in memory tool.
const memory = new ToolRegistry();
memory.register(createMemoryTool({ backend: new MapKvBackend() }));

// Portal: one two-tool MCP surface, three upstreams.
// Upstream tools are namespaced by id: "fs__read_file", "github__list_repos", …
const portal = createPortalServer({
  serverInfo: { name: "wasmagent-portal-recipe", version: "1.0.0" },
  kernel: new JsKernel(), // swap to QuickJSKernel for edge-safe execution
  capabilities: {
    allowedHosts: ["api.github.com"],
    allowedReadPaths: ["/workspace"],
    cpuMs: 5000,
  },
  upstreams: [
    { id: "fs",     tools: fs,     description: "workspace files" },
    { id: "github", tools: github, description: "Git hosting" },
    { id: "memory", tools: memory, description: "cross-session memory" },
  ],
});

// Helper: send a JSON-RPC request to the in-process handler.
const rpc = (method, params) =>
  portal.handle({ jsonrpc: "2.0", id: 1, method, params });

// Verify the host sees exactly two tools.
const list = await rpc("tools/list");
console.log("tools/list publishes:", list.response.result.tools.map((t) => t.name));
// → [ 'docs_search', 'execute_code' ]

// Run a snippet that touches all three upstreams.
const created = await rpc("tools/call", {
  name: "execute_code",
  arguments: {
    code: `
      const repos = await callTool("github__list_repos", { org: "telleroutlook" });
      const dir   = await callTool("fs__list_dir", { path: "/workspace" });
      await callTool("memory__memory", { op: "write", key: "/demo", value: "hello" });
      return { repos, dir };
    `,
  },
});

// Poll until complete (execute_code is long-running and uses the Tasks API).
const taskId = created.taskId;
let state = "pending";
let result;
for (let i = 0; i < 50 && state !== "complete" && state !== "failed"; i++) {
  await new Promise((r) => setTimeout(r, 25));
  ({ state, result } = (await rpc("tasks/get", { id: taskId })).response.result);
}
console.log("execute_code →", state, "result:", result);
