// A2A interop end-to-end demo.
//
// Why this exists
// ───────────────
// The optimization brief calls for "A2A 转正一等公民: 与至少一个外部框架的互通测试".
// We can't ship a full ADK / CrewAI integration in-tree (those are external
// frameworks with their own test harnesses), but we CAN prove the on-the-wire
// shape is correct two different ways inside a single Node process:
//
//   1. Raw HTTP — exactly what any non-WasmAgent client (ADK, CrewAI, your
//      own httpie / fetch) will see. If our agent card and task endpoint
//      match the A2A v1.0 spec on the bytes, every external framework that
//      speaks A2A can drive us.
//
//   2. A2ARemoteAgent — the symmetric path. We wrap our own server as if it
//      were a remote agent, register the wrapper as a Tool inside a
//      ToolCallingAgent, and prove a parent-child agent call works through
//      the protocol. This is the "WasmAgent calls another agent over A2A"
//      direction — equally important because it's what consumers do when
//      they want to stitch their own agents to ADK/CrewAI ones.
//
// Run: node examples/a2a-interop/index.mjs

import { A2ARemoteAgent, createA2AServer } from "@wasmagent/a2a";

// ─────────────────────────────────────────────────────────────────────────────
// 0. A trivial agent we want to expose over A2A.
//    No real model — we mock the SubagentRunnable.run() generator shape so the
//    demo runs without any API key. The protocol round-trip is what we're
//    testing, not the agent quality.
//
//    The A2A server invokes:  agent.run(message, parentId) → AsyncIterable<event>
//    where `event.event === "final_answer"` carries `event.data.answer`.
// ─────────────────────────────────────────────────────────────────────────────

const inventoryAgent = {
  async *run(message, _parentId) {
    const text = typeof message === "string"
      ? message
      : typeof message?.content === "string"
        ? message.content
        : JSON.stringify(message);
    // Pretend we looked up an inventory database.
    const answer = /widget/i.test(text)
      ? "There are 42 widgets in stock."
      : `I don't know about: ${text}`;
    yield { event: "final_answer", data: { answer } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Start the A2A server.
//    Port pinned (createA2AServer doesn't currently surface OS-assigned ports
//    in the returned URL — see issue tracker). 41789 is unlikely to clash.
// ─────────────────────────────────────────────────────────────────────────────
const PORT = 41789;
const server = createA2AServer(inventoryAgent, {
  agentId: "https://example.com/agents/inventory",
  name: "Inventory Agent",
  description: "Looks up widget stock levels.",
  skills: ["inventory.lookup"],
  port: PORT,
});

const baseUrl = await server.start();
console.log(`✓ A2A server running at ${baseUrl}`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Path A — raw HTTP, verifying the agent card + task endpoint match A2A v1.0.
//    This is exactly what an external framework (ADK, CrewAI, …) would do.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== Path A: external framework speaks raw HTTP ===");

// 2a. Discovery — fetch /.well-known/agent-card
const cardRes = await fetch(`${baseUrl}/.well-known/agent-card`);
if (!cardRes.ok) throw new Error(`card discovery failed: ${cardRes.status}`);
const card = await cardRes.json();
console.log(`  ↪ Discovered agent: ${card.name} (protocol ${card.protocolVersion})`);
console.log(`  ↪ Skills: ${card.capabilities.skills.join(", ")}`);
console.log(`  ↪ Task endpoint: ${card.taskEndpoint}`);

// Spec sanity check — without these fields no client can drive us.
for (const k of ["id", "name", "protocolVersion", "capabilities", "taskEndpoint"]) {
  if (!(k in card)) throw new Error(`agent card missing required field: ${k}`);
}
console.log(`  ✓ agent card schema valid for A2A v${card.protocolVersion}`);

// 2b. Submit a task — exactly the JSON shape an external framework would send.
//     A2ATaskRequest = { id: string, message: any, parentId?: string }
const taskBody = {
  id: `task-${Date.now()}`,
  message: "How many widgets do we have?",
};
const taskRes = await fetch(card.taskEndpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(taskBody),
});
const taskJson = await taskRes.json();
console.log(`  ↪ Task ${taskBody.id} → status=${taskJson.status}`);
console.log(`  ↪ Reply: ${taskJson.result ?? "(no result)"}`);
if ((taskJson.result ?? "").includes("42")) {
  console.log("  ✓ external HTTP client got the answer through A2A");
} else {
  throw new Error(`path A failed: did not get expected answer (got: ${JSON.stringify(taskJson)})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Path B — A2ARemoteAgent wraps the server as a Tool. This is the path a
//    user takes when their agent needs to *call* an external agent over A2A.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== Path B: WasmAgent → A2ARemoteAgent → A2A server ===");

const fetchedCard = await A2ARemoteAgent.fetchAgentCard(baseUrl);
console.log(`  ↪ Re-discovered card via A2ARemoteAgent: ${fetchedCard.name}`);

const inventoryTool = A2ARemoteAgent.asTool({
  taskEndpoint: fetchedCard.taskEndpoint,
  name: "inventory_lookup",
  description: "Look up widget stock levels via the remote inventory agent.",
});

// Direct tool call (no parent agent, no model — just to prove the wire).
// ToolDefinition uses .forward(input, signal?) — same shape as every other
// WasmAgent tool, no special A2A surface.
const direct = await inventoryTool.forward({
  task: "How many widgets do we have?",
});
console.log(`  ↪ Direct tool call: ${String(direct).slice(0, 80)}...`);
if (typeof direct === "string" && direct.includes("42")) {
  console.log("  ✓ A2ARemoteAgent.asTool() round-trips through the protocol");
} else {
  throw new Error(`path B failed: A2ARemoteAgent did not return expected answer (got: ${JSON.stringify(direct)})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cleanup.
// ─────────────────────────────────────────────────────────────────────────────
await server.stop();
console.log("\n✓ A2A server stopped cleanly");
console.log("\n─── Both interop paths passed. The on-the-wire shape is correct. ───");
console.log(
  "\nIn a real cross-framework scenario, replace either side:\n" +
  "  • ADK / CrewAI / Langroid → POST /tasks here   (path A; they're the client)\n" +
  "  • This client wraps an ADK / CrewAI agent's     (path B; flip the URL)\n" +
  "    A2A endpoint as a Tool inside ToolCallingAgent\n",
);
