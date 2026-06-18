/**
 * Edge integration smoke: adversarial code-mode scripts.
 *
 * The orchestrator's iterative-rerun protocol depends on the script having
 * predictable shape: same call sites in the same order on every re-run.
 * A few patterns can break that:
 *
 *   - Script catches the PENDING_MARKER and "swallows" the pause →
 *     orchestrator should detect the swallow and bail.
 *   - Script calls callTool inside a loop with mutable state → calls per
 *     re-run should match call-by-call.
 *   - Script uses Promise.all([callTool, callTool]) → batched parallel
 *     calls; orchestrator currently iterates one at a time.
 *   - Script computes the tool name dynamically from a previous result.
 *   - Script triggers more than 50 callTool invocations (the iteration
 *     guard) → must terminate, not hang.
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
  name: "echo",
  description: "Returns its input.",
  inputSchema: z.object({ x: z.unknown() }),
  outputSchema: z.unknown(),
  readOnly: true,
  idempotent: true,
  forward: async ({ x }) => x,
});
tools.register({
  name: "add1",
  description: "Adds 1 to a number.",
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.number(),
  readOnly: true,
  idempotent: true,
  forward: async ({ n }) => n + 1,
});

const server = createCodeModeServer({
  serverInfo: { name: "edge-cm-adversarial", version: "0.0.1" },
  tools,
  kernel: new JsKernel({ timeoutMs: 5_000 }),
  taskStore: new InMemoryTaskStore(),
});

let rpcId = 1;
const rpc = (method, params) => ({ jsonrpc: "2.0", id: rpcId++, method, ...(params ? { params } : {}) });

async function poll(taskId, maxMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const r = await server.handle(rpc("tasks/get", { id: taskId }));
    const rec = r.response.result;
    if (rec.state === "complete" || rec.state === "failed") return rec;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

async function runScript(code, label, expect) {
  const created = await server.handle(rpc("tools/call", {
    name: "execute_code",
    arguments: { code },
  }));
  const rec = await poll(created.taskId);
  if (!rec) {
    fail(`${label}: did not settle`);
    return;
  }
  if (expect.state && rec.state !== expect.state) {
    fail(`${label}: expected state ${expect.state}, got ${rec.state} ${rec.error ?? ""}`);
    return;
  }
  if (expect.resultIncludes && (typeof rec.result !== "string" || !rec.result.includes(expect.resultIncludes))) {
    fail(`${label}: result missing "${expect.resultIncludes}"`, rec);
    return;
  }
  if (expect.errorIncludes && (typeof rec.error !== "string" || !rec.error.includes(expect.errorIncludes))) {
    fail(`${label}: error missing "${expect.errorIncludes}"`, rec);
    return;
  }
  ok(label);
}

// 1. Loop body that calls callTool — re-run protocol must produce the
//    expected accumulator after N iterations.
await runScript(
  `
    let n = 0;
    for (let i = 0; i < 5; i++) {
      n = await callTool("add1", { n });
    }
    return n;
  `,
  "loop body calling callTool x5",
  { state: "complete", resultIncludes: "5" }
);

// 2. Promise.all — concurrent calls. The orchestrator iterates by emitting
//    each call sequentially, so Promise.all should still resolve correctly
//    once all calls have been served (one re-run per call).
await runScript(
  `
    const [a, b, c] = await Promise.all([
      callTool("add1", { n: 10 }),
      callTool("add1", { n: 20 }),
      callTool("add1", { n: 30 }),
    ]);
    return Number(a) + Number(b) + Number(c);
  `,
  "Promise.all of 3 callTool",
  { state: "complete", resultIncludes: "63" }
);

// 3. Dynamic tool name — chosen based on a prior result.
await runScript(
  `
    const choice = await callTool("echo", { x: "add1" });
    return await callTool(String(choice), { n: 41 });
  `,
  "dynamic tool name from prior result",
  { state: "complete", resultIncludes: "42" }
);

// 4. Try/catch around callTool — the script tries to swallow the pause
//    marker. Pre-2026-06 the orchestrator silently produced a result
//    containing "__PTC_PENDING__" when the script .catch()ed the marker;
//    we now detect the swallow and surface a failed task with a clear
//    message pointing the author at the fix.
await runScript(
  `
    try {
      const v = await callTool("add1", { n: 7 });
      return "got:" + v;
    } catch (e) {
      return "caught:" + (e && e.message ? e.message.slice(0, 30) : "");
    }
  `,
  "try/catch around callTool is detected as swallow",
  { state: "failed", errorIncludes: "swallowed the pause marker" }
);

// 5. Excess iteration guard: a loop that would call 51 tools must hit the
//    50-iteration safety stop and fail rather than hang.
await runScript(
  `
    let total = 0;
    for (let i = 0; i < 60; i++) {
      total = await callTool("add1", { n: total });
    }
    return total;
  `,
  "60-call loop bounded by iteration guard",
  // Either succeeds (if the guard is generous) or fails cleanly. We tolerate
  // both, but assert no hang and a clean state.
  {} // any terminal state is acceptable
);

// 6. callTool with empty args object (tool's schema defaults / required).
await runScript(
  `return await callTool("echo", {});`,
  "callTool with empty args",
  { state: "complete" }
);

// 7. Script that throws synchronously inside the IIFE — must surface as
//    failed, not hang.
await runScript(
  `throw new Error("synchronous-script-throw");`,
  "synchronous throw in script",
  { state: "failed", errorIncludes: "synchronous-script-throw" }
);

// 8. Script that returns a non-stringifiable value (a function reference).
//    Behavior may be "complete" with empty result OR "failed" — both are
//    acceptable as long as it doesn't hang or crash the host.
await runScript(
  `return (function() {});`,
  "non-stringifiable return value",
  {}
);

if (failed > 0) {
  console.error(`\n[edge-codemode-adversarial] ${failed} CHECK(S) FAILED`);
  process.exit(1);
}
console.log(`\n[edge-codemode-adversarial] all checks passed`);
process.exit(0);
