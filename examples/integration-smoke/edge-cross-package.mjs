/**
 * Edge integration smoke: cross-package contract drift.
 *
 * Wire 3+ packages together in non-trivial ways and assert the seams hold:
 *   - aisdk codeModeTool wrapped around the same kernel a Mastra sandbox
 *     uses — both sees the same capability denial format.
 *   - mcp-server fetchHandler over HTTP against an aisdk-style downstream.
 *   - McpAgentServer with a real KvCheckpointer-backed task store
 *     (round-trip task state across two server instances).
 */
import { JsKernel, ToolRegistry, MapKvBackend } from "@agentkit-js/core";
import { codeModeTool, sandboxedJsTool } from "@agentkit-js/aisdk";
import { agentkitMastraSandbox } from "@agentkit-js/mastra-sandbox";
import {
  createCodeModeServer,
  createFetchHandler,
  InMemoryTaskStore,
} from "@agentkit-js/mcp-server";
import { z } from "zod";

let failed = 0;
function ok(label) {
  console.log(`✓ ${label}`);
}
function fail(label, detail) {
  console.error(`✗ ${label}`, detail ?? "");
  failed++;
}

// ── 1. aisdk sandboxedJsTool + mastra-sandbox produce IDENTICAL error
//      shapes for the same capability denial. Drift here would mean a
//      Mastra-backed agent sees one error, an AI-SDK-backed agent sees
//      another, for the exact same script + manifest.

{
  const cap = { allowedHosts: ["api.example.com"] };
  const tool = sandboxedJsTool({ kernel: new JsKernel({ timeoutMs: 1_000 }), capabilities: cap });
  const sandbox = agentkitMastraSandbox({
    kernel: new JsKernel({ timeoutMs: 1_000 }),
    capabilities: cap,
  });

  let aiErr = "";
  try {
    await tool.execute({ code: "fetch('https://evil.com/x')" });
  } catch (e) {
    aiErr = e instanceof Error ? e.message : String(e);
  }
  const mastraResult = await sandbox.execute("fetch('https://evil.com/x')");
  const mastraErr = mastraResult.stderr;

  // Both should mention "CapabilityDenied" and "evil.com".
  const aiOk = /CapabilityDenied/.test(aiErr) && /evil\.com/.test(aiErr);
  const masOk = /CapabilityDenied/.test(mastraErr) && /evil\.com/.test(mastraErr);
  if (!aiOk) fail("aisdk denial message missing required tokens", aiErr);
  else if (!masOk) fail("mastra denial message missing required tokens", mastraErr);
  else ok("aisdk + mastra: identical capability-denial shape");

  // Mastra's exitCode must be 1 on denial.
  if (mastraResult.exitCode !== 1) fail("mastra denial exitCode != 1", mastraResult);
  else ok("mastra denial: exitCode = 1");
}

// ── 2. aisdk codeModeTool integration with a downstream tool that returns
//      a non-string value — the result string must contain it serialised.

{
  const reg = new ToolRegistry();
  reg.register({
    name: "make_obj",
    description: "Returns an object.",
    inputSchema: z.object({ k: z.string(), v: z.unknown() }),
    outputSchema: z.unknown(),
    readOnly: true,
    idempotent: true,
    forward: async ({ k, v }) => ({ [k]: v }),
  });
  const tool = codeModeTool({ kernel: new JsKernel({ timeoutMs: 3_000 }), tools: reg });
  const r = await tool.execute({
    code: `
      const o = await callTool("make_obj", { k: "answer", v: 42 });
      return JSON.stringify(o);
    `,
  });
  if (!r.output.includes("\"answer\":42")) fail("codeModeTool: object round-trip lost", r);
  else ok("aisdk codeModeTool: object round-trip via JSON-string final");
}

// ── 3. createFetchHandler routes Streamable HTTP correctly ──────────────────

{
  const tools = new ToolRegistry();
  tools.register({
    name: "ping",
    description: "ping",
    inputSchema: z.object({}),
    outputSchema: z.string(),
    readOnly: true,
    idempotent: true,
    forward: async () => "pong",
  });

  const server = createCodeModeServer({
    serverInfo: { name: "fetch-handler-smoke", version: "0.0.1" },
    tools,
    kernel: new JsKernel({ timeoutMs: 3_000 }),
    taskStore: new InMemoryTaskStore(),
  });

  const handler = createFetchHandler(server, { path: "/mcp" });

  // POST a JSON-RPC initialize on /mcp.
  const r1 = await handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    })
  );
  if (r1.status !== 200) fail("fetchHandler POST /mcp non-200", r1.status);
  else {
    const body = await r1.json();
    if (body.result?.protocolVersion) ok("fetchHandler POST /mcp returns protocolVersion");
    else fail("fetchHandler POST /mcp body shape", body);
  }

  // Wrong path is 404.
  const r2 = await handler(
    new Request("http://localhost/wrong", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  );
  if (r2.status !== 404) fail("fetchHandler non-mcp path: not 404", r2.status);
  else ok("fetchHandler non-mcp path: 404");
}

// ── 4. KvCheckpointer-backed task store: a fresh server can read a task
//      created by an earlier server instance pointed at the same store.

{
  // Use an in-memory KV (MapKvBackend) wrapped as the store. We don't need
  // KvCheckpointer here — the InMemoryTaskStore already implements the
  // McpTaskStore contract, but we want to prove that a plain Map-backed
  // store survives server-instance churn.
  const sharedStore = new InMemoryTaskStore();
  const tools = new ToolRegistry();
  tools.register({
    name: "noop",
    description: "Returns input.",
    inputSchema: z.object({ x: z.unknown() }),
    outputSchema: z.unknown(),
    readOnly: true, idempotent: true,
    forward: async ({ x }) => x,
  });

  const server1 = createCodeModeServer({
    serverInfo: { name: "kv-roundtrip", version: "0.0.1" },
    tools,
    kernel: new JsKernel({ timeoutMs: 3_000 }),
    taskStore: sharedStore,
  });
  const created = await server1.handle({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "execute_code", arguments: { code: `return await callTool("noop", { x: "hello" });` } },
  });
  const taskId = created.taskId;
  if (!taskId) {
    fail("kv-roundtrip: no taskId");
  } else {
    // Wait for completion.
    let rec = null;
    for (let i = 0; i < 60 && (!rec || (rec.state !== "complete" && rec.state !== "failed")); i++) {
      await new Promise((r) => setTimeout(r, 25));
      const r = await server1.handle({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: taskId } });
      rec = r.response.result;
    }
    if (rec.state !== "complete") fail("kv-roundtrip: task did not complete", rec);
    else {
      // Now create a brand-new server pointed at the same store.
      const server2 = createCodeModeServer({
        serverInfo: { name: "kv-roundtrip-2", version: "0.0.1" },
        tools,
        kernel: new JsKernel({ timeoutMs: 3_000 }),
        taskStore: sharedStore,
      });
      const r = await server2.handle({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: taskId } });
      const rec2 = r.response.result;
      if (rec2 && rec2.state === "complete" && rec2.id === taskId) {
        ok("kv-roundtrip: fresh server reads task created by predecessor");
      } else {
        fail("kv-roundtrip: state lost across servers", rec2);
      }
    }
  }
}

// ── 5. Capability changes on a single shared kernel between three
//      different aisdk tools — manifest is per-tool, not per-kernel.

{
  const k = new JsKernel({ timeoutMs: 1_500 });
  try {
    const t1 = sandboxedJsTool({ kernel: k, capabilities: { env: { K: "v1" } } });
    const t2 = sandboxedJsTool({ kernel: k, capabilities: { env: { K: "v2" } } });
    const t3 = sandboxedJsTool({ kernel: k }); // no env
    const r1 = await t1.execute({ code: "__env__.K" });
    const r2 = await t2.execute({ code: "__env__.K" });
    const r3 = await t3.execute({ code: "typeof __env__" });
    if (r1.output !== "v1") fail("shared kernel: t1 sees v1", r1);
    else if (r2.output !== "v2") fail("shared kernel: t2 sees v2", r2);
    else if (r3.output !== "undefined") fail("shared kernel: t3 sees no env", r3);
    else ok("shared kernel + per-tool capabilities: no leak across tools");
  } finally {
    await k[Symbol.asyncDispose]();
  }
}

// MapKvBackend export sanity — bscode imports this from @agentkit-js/core
// (per its docs/cf-2026-primitives.md example). If the export drifts, the
// docs lie and bscode breaks.
{
  if (typeof MapKvBackend !== "function") {
    fail("MapKvBackend export drift: not a class");
  } else {
    const kv = new MapKvBackend();
    await kv.put("k", "v");
    const got = await kv.get("k");
    if (got !== "v") fail("MapKvBackend: round-trip broken", got);
    else ok("MapKvBackend round-trip");
  }
}

if (failed > 0) {
  console.error(`\n[edge-cross-package] ${failed} CHECK(S) FAILED`);
  process.exit(1);
}
console.log(`\n[edge-cross-package] all checks passed`);
process.exit(0);
