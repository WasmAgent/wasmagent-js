/**
 * Edge integration smoke: MCP protocol fuzzing + execute_code inputs.
 *
 * Drives McpAgentServer + createCodeModeServer with malformed envelopes
 * and adversarial scripts. Asserts the server returns a JSON-RPC error
 * (the right code, the right shape) rather than crashing or hanging.
 */
import { JsKernel, ToolRegistry } from "@wasmagent/core";
import { createCodeModeServer, InMemoryTaskStore } from "@wasmagent/mcp-server";
import { z } from "zod";

let failed = 0;
function ok(label) {
  console.log(`✓ ${label}`);
}
function fail(label, detail) {
  console.error(`✗ ${label}`, detail ?? "");
  failed++;
}

const tools = new ToolRegistry();
tools.register({
  name: "noop",
  description: "Returns its input.",
  inputSchema: z.object({ x: z.unknown() }),
  outputSchema: z.unknown(),
  readOnly: true,
  idempotent: true,
  forward: async ({ x }) => x,
});
tools.register({
  name: "throws",
  description: "Always throws.",
  inputSchema: z.object({}),
  outputSchema: z.unknown(),
  readOnly: false,
  idempotent: false,
  forward: async () => {
    throw new Error("synthetic-tool-failure");
  },
});

const server = createCodeModeServer({
  serverInfo: { name: "edge-mcp", version: "0.0.1" },
  tools,
  kernel: new JsKernel({ timeoutMs: 5_000 }),
  taskStore: new InMemoryTaskStore(),
});

let nextId = 1;
const id = () => nextId++;
const rpc = (method, params) => ({ jsonrpc: "2.0", id: id(), method, ...(params ? { params } : {}) });

// Helper: poll a task to terminal state.
async function poll(taskId, maxMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const got = await server.handle({ jsonrpc: "2.0", id: id(), method: "tasks/get", params: { id: taskId } });
    const rec = got.response.result;
    if (rec.state === "complete" || rec.state === "failed") return rec;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

// 1. Unknown method → -32601
{
  const r = await server.handle(rpc("not/a/method"));
  if (r.response.error?.code !== -32601) fail("unknown method → -32601", r.response);
  else ok("unknown method → -32601");
}

// 2. tools/call missing name → -32602
{
  const r = await server.handle(rpc("tools/call", { arguments: {} }));
  if (r.response.error?.code !== -32602) fail("missing tool name → -32602", r.response);
  else ok("missing tool name → -32602");
}

// 3. tools/call with unknown tool name → -32011 (TOOL_NOT_FOUND)
{
  const r = await server.handle(rpc("tools/call", { name: "nope", arguments: {} }));
  if (r.response.error?.code !== -32011) fail("unknown tool → -32011", r.response);
  else ok("unknown tool → -32011");
}

// 4. Malformed body (not a JSON-RPC object) → ERR_INVALID_REQUEST or PARSE
{
  const r = await server.handle("not an object");
  if (!r.response.error) fail("malformed body should error", r.response);
  else ok(`malformed body → ${r.response.error.code}`);
}

// 5. Null id is permissible per JSON-RPC (notifications). The server
//    should at least not crash.
{
  const r = await server.handle({ jsonrpc: "2.0", id: null, method: "tools/list" });
  if (!r.response) fail("null id: no response object", r);
  else if (r.response.id !== null) fail("null id: id should round-trip as null", r.response);
  else ok("null id round-trips correctly");
}

// 6. tasks/get on unknown id → -32010 (TASK_NOT_FOUND)
{
  const r = await server.handle(rpc("tasks/get", { id: "nonexistent-task" }));
  if (r.response.error?.code !== -32010) fail("unknown task id → -32010", r.response);
  else ok("unknown task id → -32010");
}

// 7. execute_code with a tool that throws — task ends in failed
{
  const created = await server.handle(rpc("tools/call", {
    name: "execute_code",
    arguments: { code: `return await callTool("throws", {});` },
  }));
  const taskId = created.taskId;
  const rec = await poll(taskId);
  if (!rec) fail("throws-tool: task did not settle in time");
  else if (rec.state !== "failed") fail("throws-tool: expected failed state", rec);
  else if (!rec.error || !rec.error.includes("synthetic-tool-failure")) {
    fail("throws-tool: error message lost", rec);
  } else ok("throws-tool propagates as failed task");
}

// 8. execute_code that times out (cpuMs hit) — task ends in failed
{
  const codeModeServerWithTimeout = createCodeModeServer({
    serverInfo: { name: "edge-mcp-tight", version: "0.0.1" },
    tools,
    kernel: new JsKernel({ timeoutMs: 200 }),
    capabilities: { cpuMs: 200 },
    taskStore: new InMemoryTaskStore(),
  });
  const created = await codeModeServerWithTimeout.handle(rpc("tools/call", {
    name: "execute_code",
    arguments: { code: "while(true){}" },
  }));
  const taskId = created.taskId;
  // Need our own poll because the new server has its own state.
  const start = Date.now();
  let rec = null;
  while (Date.now() - start < 5000) {
    const got = await codeModeServerWithTimeout.handle({
      jsonrpc: "2.0", id: id(), method: "tasks/get", params: { id: taskId },
    });
    rec = got.response.result;
    if (rec.state === "complete" || rec.state === "failed") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!rec || rec.state !== "failed") fail("infinite-loop: expected failed", rec);
  else if (!rec.error || !/timed out/i.test(rec.error)) fail("infinite-loop: wrong error", rec);
  else ok("infinite-loop bounded by cpuMs");
}

// 9. Moderately large script bodies (~16 KB) — ensures the orchestrator's
//    script wrapping doesn't blow up on real-world prompt sizes. We use 16K
//    rather than 256K because the iteration protocol re-runs the script
//    several times under the hood; on JsKernel each re-run pays a worker
//    postMessage round-trip, so 256K-source scripts are within parser
//    capability but exceed CI-friendly wall-clock.
{
  const big = "1+".repeat(4_000) + "0";
  const created = await server.handle(rpc("tools/call", {
    name: "execute_code",
    arguments: { code: `return (${big});` },
  }));
  const rec = await poll(created.taskId, 8000);
  if (!rec) fail("16KB script: did not settle");
  else if (rec.state !== "complete") fail("16KB script: not complete", rec);
  else ok(`16KB script completed (result=${String(rec.result).slice(0, 20)}…)`);
}

// 10. tools/call on `execute_code` with non-string `code` → failed task with
//     a sane error. The server's resolveTask coerces to String() so the
//     downstream agent sees something; the orchestrator should reject empty.
{
  const created = await server.handle(rpc("tools/call", {
    name: "execute_code",
    arguments: { code: 42 },
  }));
  const rec = await poll(created.taskId, 3000);
  if (!rec) fail("non-string code: did not settle");
  else if (rec.state === "failed") ok("non-string code rejected cleanly");
  else if (rec.state === "complete") ok(`non-string code coerced (result=${rec.result})`);
  else fail("non-string code: unexpected state", rec);
}

if (failed > 0) {
  console.error(`\n[edge-mcp-protocol] ${failed} CHECK(S) FAILED`);
  process.exit(1);
}
console.log(`\n[edge-mcp-protocol] all checks passed`);
process.exit(0);
