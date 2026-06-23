/**
 * D1 — MCP Portal example: federate 3 different tool sources behind one
 * two-tool MCP surface.
 *
 * Sources:
 *   1. `fs`     — a small filesystem-style upstream (read_file / list_dir).
 *   2. `github` — a GitHub-like upstream (list_repos / create_issue).
 *   3. `memory` — WasmAgent's built-in cross-session memory tool.
 *
 * The host (Claude Code, Cursor, custom MCP client) sees ONE server with
 * ONLY `docs_search` and `execute_code`. Inside `execute_code`, the model
 * dispatches to whichever upstream it needs — `callTool("github__list_repos",
 * {...})`, `callTool("memory__memory", {...})`, etc. — under one shared
 * `CapabilityManifest`.
 *
 * Run locally:
 *   node examples/mcp-portal/index.mjs
 *
 * The script does NOT need network access; it drives the Portal directly via
 * its in-process JSON-RPC handler so you can inspect the responses.
 */
import { JsKernel, ToolRegistry, MapKvBackend, createMemoryTool } from "@wasmagent/core";
import { createPortalServer } from "@wasmagent/mcp-server";
import { z } from "zod";

// ── 1. Upstream A: filesystem-like (in-process, easily swapped for real MCP) ─
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

// ── 2. Upstream B: GitHub-like ──────────────────────────────────────────────
const github = new ToolRegistry();
github.register({
  name: "list_repos",
  description: "List repositories in an org.",
  inputSchema: z.object({ org: z.string() }),
  outputSchema: z.array(z.string()),
  readOnly: true,
  idempotent: true,
  forward: async ({ org }) => [`${org}/WasmAgent`, `${org}/bscode`],
});
github.register({
  name: "create_issue",
  description: "Open an issue on a repository.",
  inputSchema: z.object({ repo: z.string(), title: z.string() }),
  outputSchema: z.object({ url: z.string() }),
  readOnly: false,
  idempotent: false,
  forward: async ({ repo, title }) => ({ url: `https://example/${repo}/issues/1?t=${title}` }),
});

// ── 3. Upstream C: WasmAgent's own memory tool, federated alongside the rest ─
const memory = new ToolRegistry();
memory.register(createMemoryTool({ backend: new MapKvBackend() }));

// ── Portal: one MCP face, three upstreams ───────────────────────────────────
const portal = createPortalServer({
  serverInfo: { name: "WasmAgent-portal-demo", version: "1.0.0" },
  // JsKernel for the demo — production deployments swap to QuickJSKernel
  // (edge-safe) or RemoteSandboxKernel (microVM) without touching this code.
  kernel: new JsKernel(),
  // ONE capability manifest spans every upstream tool call.
  capabilities: {
    allowedHosts: ["api.github.com"],
    allowedReadPaths: ["/workspace"],
    cpuMs: 5000,
  },
  upstreams: [
    { id: "fs", tools: fs, description: "workspace files" },
    { id: "github", tools: github, description: "Git hosting" },
    { id: "memory", tools: memory, description: "cross-session memory" },
  ],
});

// ── Demo: list tools, then run a script that touches all three upstreams ────
async function rpc(method, params) {
  return portal.handle({ jsonrpc: "2.0", id: 1, method, params });
}

const list = await rpc("tools/list");
console.log("tools/list publishes:", list.response.result.tools.map((t) => t.name));
// → [ 'docs_search', 'execute_code' ]

const search = await rpc("tools/call", { name: "docs_search", arguments: {} });
console.log("\ndocs_search:\n" + search.response.result.content[0].text + "\n");

const created = await rpc("tools/call", {
  name: "execute_code",
  arguments: {
    code: `
      const repos = await callTool("github__list_repos", { org: "telleroutlook" });
      const dir = await callTool("fs__list_dir", { path: "/workspace" });
      await callTool("memory__memory", { op: "write", key: "/notes/portal-demo", value: "hello from portal" });
      return { repos, dir };
    `,
  },
});

// Poll until the long-running execute_code finishes.
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
