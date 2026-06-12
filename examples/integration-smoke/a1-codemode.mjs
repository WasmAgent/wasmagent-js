#!/usr/bin/env node
/**
 * A1 (S1) integration smoke — drive createCodeModeServer over JSON-RPC like
 * a real MCP host. Locally-runnable; not part of CI (lives outside
 * `examples/benchmarks/run-all.mjs`). Usage:
 *
 *   node scripts/integration/a1-codemode.mjs
 *
 * Verifies:
 *   - tools/list publishes exactly docs_search + execute_code
 *   - docs_search substring filter works
 *   - execute_code runs a 2-tool chain and ONLY the final value crosses
 *     the wire (intermediate `search_docs` output must reach the script
 *     to produce that final value, but is not visible directly).
 */
import { JsKernel, ToolRegistry } from "@agentkit-js/core";
import { InMemoryTaskStore, createCodeModeServer } from "@agentkit-js/mcp-server";
import { z } from "zod";

const tools = new ToolRegistry();
tools.register({
  name: "search_docs",
  description: "Returns 3 fake docs matching `query`.",
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.array(z.string()),
  readOnly: true,
  idempotent: true,
  forward: async ({ query }) => [`doc-1: ${query}`, `doc-2: ${query}`, `doc-3: ${query}`],
});
tools.register({
  name: "summarise",
  description: "Returns the first n chars joined.",
  inputSchema: z.object({ items: z.array(z.string()), max: z.number() }),
  outputSchema: z.string(),
  readOnly: true,
  idempotent: true,
  forward: async ({ items, max }) => items.join(" | ").slice(0, max),
});

const server = createCodeModeServer({
  serverInfo: { name: "smoke-server", version: "0.1.0" },
  tools,
  kernel: new JsKernel({ timeoutMs: 5_000 }),
  taskStore: new InMemoryTaskStore(),
});

const id = (n) => ({ jsonrpc: "2.0", id: n });

let r = await server.handle({ ...id(1), method: "initialize" });
const protocol = r.response.result.protocolVersion;
console.log("[A1] initialize.protocolVersion =", protocol);
if (!protocol) throw new Error("no protocol version");

r = await server.handle({ ...id(2), method: "tools/list" });
const toolNames = r.response.result.tools.map((t) => t.name).sort();
console.log("[A1] tools/list =", toolNames.join(","));
if (toolNames.join(",") !== "docs_search,execute_code") {
  throw new Error("tools/list mismatch — expected docs_search,execute_code");
}

r = await server.handle({
  ...id(3),
  method: "tools/call",
  params: { name: "docs_search", arguments: { query: "summari" } },
});
const docsText = r.response.result.content[0].text;
if (!docsText.includes("summarise")) throw new Error("docs_search filter broken");
console.log("[A1] docs_search filtered to 'summarise' ✓");

const code = `
  const docs = await callTool("search_docs", { query: "cache" });
  return await callTool("summarise", { items: docs, max: 30 });
`;
const created = await server.handle({
  ...id(4),
  method: "tools/call",
  params: { name: "execute_code", arguments: { code } },
});
const taskId = created.taskId;
if (!taskId) throw new Error("no taskId returned");
console.log("[A1] execute_code → task", taskId);

let ok = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 50));
  const got = await server.handle({ ...id(5), method: "tasks/get", params: { id: taskId } });
  const rec = got.response.result;
  if (rec.state === "complete") {
    console.log("[A1] task complete; result =", JSON.stringify(rec.result).slice(0, 80));
    if (typeof rec.result !== "string") throw new Error("expected string result");
    if (!rec.result.includes("doc-1: cache")) throw new Error("expected 'doc-1: cache' in final");
    ok = true;
    break;
  }
  if (rec.state === "failed") throw new Error("task failed: " + rec.error);
}
if (!ok) throw new Error("task did not complete in time");

// Tear down the kernel worker so Node exits.
process.exit(0);
