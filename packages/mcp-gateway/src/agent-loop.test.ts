import { InMemoryCheckpointer, type RunPolicyGateway, ToolCallingAgent } from "@wasmagent/core";
import {
  computeToolSnapshotHash,
  InMemoryToolSecurityProfileRegistry,
  MCPGateway,
} from "@wasmagent/mcp-firewall";
import type { McpToolEntry } from "@wasmagent/mcp-server";
import { z } from "zod";
import { createAgentPolicyGateway } from "./agent-loop.js";

// ── IF-07c: agent-loop provenance wiring, end to end ───────────────────────
// Real ToolCallingAgent + real MCPGateway + the adapter. A secret read by a
// profile-labeled tool must be blocked from reaching a network-sink tool by
// the IF-07a gate automatically — no caller-side provenance threading.
//
// Threading posture (honest semantics): the adapter threads the WHOLE run
// ledger, which is the caller's declaration per IF-07a — so once a labeled
// read happens in a run, later deny-sink calls are denied by the label rule
// even when their args carry none of the labeled content. A legitimate flow
// that must act on tainted data goes through the operator-profile path
// (e.g. honest sink declarations), exactly as documented in IF-07a.

const SECRET = "sk-live-integration-secret-000123";

const SERVER = "test-srv";

function entry(name: string, description: string, schema: object): McpToolEntry {
  return { name, description, inputSchema: schema };
}

const searchEntry = entry("search_docs", "search documents", {
  type: "object",
  properties: { key: { type: "string" } },
  required: ["key"],
});
const sendEntry = entry("send_report", "send report", {
  type: "object",
  properties: { body: { type: "string" } },
  required: ["body"],
});
const encodeEntry = entry("transform_text", "applies a text transform", {
  type: "object",
  properties: { data: { type: "string" } },
  required: ["data"],
});
const plainEntry = entry("plain_echo", "echo text", {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
});

function profileRegistryWithLabeledVault() {
  const registry = new InMemoryToolSecurityProfileRegistry();
  // search_docs: operator declares its RESULTS carry a secret — the
  // operator-authoritative mint (no DLP). Read-only otherwise.
  registry.register({
    toolSnapshotHash: computeToolSnapshotHash(searchEntry, SERVER),
    effects: [],
    sinks: [],
    capabilitiesRequired: [],
    resultTaintLabels: ["secret"],
  });
  // transform_text: its OUTPUT is the (transformed) secret it encoded.
  registry.register({
    toolSnapshotHash: computeToolSnapshotHash(encodeEntry, SERVER),
    effects: [],
    sinks: [],
    capabilitiesRequired: [],
    resultTaintLabels: ["secret"],
  });
  // send_report: network sink, declared facts.
  registry.register({
    toolSnapshotHash: computeToolSnapshotHash(sendEntry, SERVER),
    effects: ["network"],
    sinks: ["network_send"],
    capabilitiesRequired: [],
  });
  // plain_echo: benign, unlabeled.
  registry.register({
    toolSnapshotHash: computeToolSnapshotHash(plainEntry, SERVER),
    effects: [],
    sinks: [],
    capabilitiesRequired: [],
  });
  return registry;
}

let searchCalls = 0;
let sendCalls = 0;
let encodeCalls = 0;

function coreTools(): any[] {
  searchCalls = 0;
  sendCalls = 0;
  encodeCalls = 0;
  return [
    {
      name: "search_docs",
      description: "search documents",
      inputSchema: z.object({ key: z.string() }),
      outputSchema: z.string(),
      readOnly: true,
      idempotent: true,
      forward: async () => {
        searchCalls++;
        return SECRET;
      },
    },
    {
      name: "send_report",
      description: "send report",
      inputSchema: z.object({ body: z.string() }),
      outputSchema: z.string(),
      readOnly: false,
      idempotent: false,
      forward: async ({ body }: { body: string }) => {
        sendCalls++;
        return `sent:${body}`;
      },
    },
    {
      name: "transform_text",
      description: "applies a text transform",
      inputSchema: z.object({ data: z.string() }),
      outputSchema: z.string(),
      readOnly: true,
      idempotent: true,
      forward: async ({ data }: { data: string }) => {
        encodeCalls++;
        return Buffer.from(data, "utf8").toString("base64");
      },
    },
    {
      name: "plain_echo",
      description: "echo text",
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.string(),
      readOnly: true,
      idempotent: true,
      forward: async ({ text }: { text: string }) => text,
    },
  ];
}

function scriptedModel(
  steps: Array<{
    text?: string;
    calls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  }>
) {
  let i = 0;
  return {
    providerId: "mock/test",
    async *generate(): AsyncGenerator<{ type: string; delta?: string; toolCall?: unknown }> {
      const step = steps[i++] ?? { text: "(script exhausted)" };
      for (const c of step.calls ?? []) {
        yield {
          type: "tool_call",
          toolCall: { type: "tool_use", id: c.id, name: c.name, input: c.input },
        };
      }
      if (step.text) yield { type: "text_delta", delta: step.text };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

function wiredAgent(model: unknown, toolDescriptors: McpToolEntry[], checkpointer?: unknown) {
  const gateway = new MCPGateway({
    profileRegistry: profileRegistryWithLabeledVault(),
  });
  const policyGateway = createAgentPolicyGateway({
    gateway,
    toolDescriptors,
    serverId: SERVER,
    principal: "it-agent",
  });
  return new ToolCallingAgent({
    model: model as any,
    tools: coreTools(),
    maxSteps: 8,
    ...(checkpointer ? { checkpointer } : {}),
    policyGateway: policyGateway as unknown as RunPolicyGateway,
  });
}

async function collect(run: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const e of run) events.push(e);
  return events;
}

describe("agent-loop provenance wiring (IF-07c) — end to end", () => {
  it("blocks secret → network-send automatically via the label rule (no caller threading)", async () => {
    const agent = wiredAgent(
      scriptedModel([
        { calls: [{ id: "c1", name: "search_docs", input: { key: "k" } }] },
        { calls: [{ id: "c2", name: "send_report", input: { body: SECRET } }] },
        { text: "I could not send it." },
      ]),
      [searchEntry, sendEntry, encodeEntry, plainEntry]
    );
    const events = await collect(agent.run("exfiltrate the secret"));
    // The labeled read happened; the exfil attempt never executed.
    expect(searchCalls).toBe(1);
    expect(sendCalls).toBe(0);
    // Blocked by the IF-07a label rule — automatically threaded by the loop.
    const blocked = [...events.filter((e) => e.event === "tool_result")].at(-1);
    expect(JSON.stringify(blocked?.data)).toContain("sink-tainted-provenance-deny");
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
  });

  it("whole-run threading is strict: after a labeled read, a benign-arg deny-sink call is still gated", async () => {
    const agent = wiredAgent(
      scriptedModel([
        { calls: [{ id: "c1", name: "search_docs", input: { key: "k" } }] },
        { calls: [{ id: "c2", name: "plain_echo", input: { text: "hello" } }] },
        { calls: [{ id: "c3", name: "send_report", input: { body: "public news" } }] },
        { text: "could not send." },
      ]),
      [searchEntry, sendEntry, encodeEntry, plainEntry]
    );
    const events = await collect(agent.run("read then send public news"));
    // plain_echo (no deny sink) is unaffected…
    expect(searchCalls).toBe(1);
    // …but send_report runs after a labeled read with deny-sink classification,
    // so the label rule gates it regardless of its benign args. The legitimate
    // path is the operator profile (e.g. honest sink declarations), per IF-07a.
    expect(sendCalls).toBe(0);
    const lastResult = [...events.filter((e) => e.event === "tool_result")].at(-1);
    expect(JSON.stringify(lastResult?.data)).toContain("sink-tainted-provenance-deny");
  });

  it("blocks a transformed secret via content identity (base64 through a labeled tool)", async () => {
    const b64 = Buffer.from(SECRET, "utf8").toString("base64");
    const agent = wiredAgent(
      scriptedModel([
        { calls: [{ id: "c1", name: "search_docs", input: { key: "k" } }] },
        { calls: [{ id: "c2", name: "transform_text", input: { data: SECRET } }] },
        { calls: [{ id: "c3", name: "send_report", input: { payload: b64 } }] },
        { text: "nope." },
      ]),
      [searchEntry, sendEntry, encodeEntry, plainEntry]
    );
    const events = await collect(agent.run("encode then send"));
    expect(searchCalls).toBe(1);
    expect(encodeCalls).toBe(1);
    expect(sendCalls).toBe(0);
    // The send_report attempt's arg hashes to the encoded observation — the
    // identity rule fires alongside the label rule.
    const lastResult = [...events.filter((e) => e.event === "tool_result")].at(-1);
    const blockedMessage = JSON.stringify(lastResult?.data);
    expect(blockedMessage).toContain("sink-tainted-identity-deny");
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
  });

  it("benign runs without labeled reads are never gated", async () => {
    const agent = wiredAgent(
      scriptedModel([
        { calls: [{ id: "c1", name: "plain_echo", input: { text: "hello" } }] },
        { calls: [{ id: "c2", name: "send_report", input: { body: "public news" } }] },
        { text: "sent the public report." },
      ]),
      [searchEntry, sendEntry, encodeEntry, plainEntry]
    );
    const events = await collect(agent.run("send a public report"));
    expect(sendCalls).toBe(1);
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("sink-tainted-provenance-deny");
  });

  it("denies fail-closed when the wired descriptor set does not know a tool", async () => {
    const agent = wiredAgent(
      scriptedModel([
        { calls: [{ id: "c1", name: "unknown_tool", input: { x: 1 } }] },
        { text: "done" },
      ]),
      [searchEntry, sendEntry, encodeEntry, plainEntry]
    );
    const events = await collect(agent.run("call something unknown"));
    const result = events.find((e) => e.event === "tool_result");
    expect(JSON.stringify(result?.data)).toContain("descriptor-unavailable");
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
  });

  it("maps gateway ask_user to the agent confirm flow: fail-closed without a checkpointer, executable on approval", async () => {
    // plain_echo2 has a descriptor but NO profile → hardened gateway
    // escalates unprofiled read-like tools (ask_user) → adapter returns confirm.
    const unprofiled = entry("plain_echo2", "echoes text back", {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    const script = [
      { calls: [{ id: "c1", name: "plain_echo2", input: { text: "hi" } }] },
      { text: "done" },
    ];
    const echoTool = {
      name: "plain_echo2",
      description: "echoes text back",
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.string(),
      readOnly: true,
      idempotent: true,
      forward: async () => {
        executed++;
        return "hi";
      },
    };
    let executed = 0;
    const gateway = new MCPGateway({ profileRegistry: profileRegistryWithLabeledVault() });
    const policyGateway = createAgentPolicyGateway({
      gateway,
      toolDescriptors: [unprofiled],
      serverId: SERVER,
    });

    // Without a checkpointer the confirm degrades to a fail-closed deny.
    const agentNoCp = new ToolCallingAgent({
      model: scriptedModel(script) as any,
      tools: [echoTool],
      maxSteps: 8,
      policyGateway: policyGateway as unknown as RunPolicyGateway,
    });
    const eventsNoCp = await collect(agentNoCp.run("echo"));
    expect(executed).toBe(0);
    expect(JSON.stringify(eventsNoCp)).toContain("consent-unavailable");

    // With a checkpointer, approving the gateway's escalation executes the call.
    const checkpointer = new InMemoryCheckpointer();
    const agentCp = new ToolCallingAgent({
      model: scriptedModel(script) as any,
      tools: [echoTool],
      maxSteps: 8,
      checkpointer,
      policyGateway: policyGateway as unknown as RunPolicyGateway,
    });
    const events: any[] = [];
    for await (const e of agentCp.run("echo")) {
      events.push(e);
      if (e.event === "await_human_input") {
        await checkpointer.respond(e.traceId as string, e.data.promptId, "yes");
      }
    }
    expect(executed).toBe(1);
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
  });
});

describe("agent-loop provenance wiring (IF-07c) — dispatch-time re-authorization (#505)", () => {
  const SECRET = "sk-live-integration-secret-000123";
  const objectSinkEntry = entry("send_payload", "ingest structured payload", {
    type: "object",
    properties: { body: { type: "object" } },
    required: ["body"],
  });

  function registryWithObjectSink() {
    const registry = profileRegistryWithLabeledVault();
    registry.register({
      toolSnapshotHash: computeToolSnapshotHash(objectSinkEntry, SERVER),
      effects: ["network"],
      sinks: ["network_send"],
      capabilitiesRequired: [],
    });
    return registry;
  }

  it("re-authorizes a $ref-dependent object sink at dispatch: denied with a provenance rule, zero executions (#505)", async () => {
    const sinkCalls: unknown[] = [];
    const sinkTool = {
      name: "send_payload",
      description: "ingest structured payload",
      inputSchema: z.object({ body: z.any() }),
      outputSchema: z.string(),
      readOnly: false,
      idempotent: false,
      forward: async (args: unknown) => {
        sinkCalls.push(args);
        return "ingested";
      },
    };
    const searchTool = {
      name: "search_docs",
      description: "search documents",
      inputSchema: z.object({ key: z.string() }),
      outputSchema: z.string(),
      readOnly: true,
      idempotent: true,
      forward: async () => SECRET,
    };
    const gateway = new MCPGateway({ profileRegistry: registryWithObjectSink() });
    const policyGateway = createAgentPolicyGateway({
      gateway,
      toolDescriptors: [searchEntry, objectSinkEntry],
      serverId: SERVER,
      principal: "reauth-probe",
    });
    const agent = new ToolCallingAgent({
      model: scriptedModel([
        {
          calls: [
            { id: "c1", name: "search_docs", input: { key: "k" } },
            { id: "c2", name: "send_payload", input: { body: "$c1" } },
          ],
        },
        { text: "done" },
      ]) as any,
      tools: [searchTool, sinkTool],
      maxSteps: 8,
      policyGateway: policyGateway as unknown as RunPolicyGateway,
    });
    const events: any[] = [];
    for await (const e of agent.run("probe same-batch ref")) events.push(e);

    // The sink must NOT execute — the secret must not reach it.
    expect(sinkCalls.length).toBe(0);
    // A provenance rule must fire at the dispatch-time re-evaluation.
    const statuses = events.filter(
      (e) =>
        e.event === "status" &&
        e.data?.phase === "policy_denied" &&
        e.data?.toolName === "send_payload"
    );
    expect(statuses.length).toBe(1);
    expect(statuses[0].data.ruleIds).toContain("sink-tainted-provenance-deny");
    // The denial lands as a blocked tool_result and the run still completes.
    const result = events.find((e) => e.event === "tool_result" && e.data?.callId === "c2");
    expect(JSON.stringify(result?.data)).toContain("sink-tainted-provenance-deny");
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
  });

  it("parallel mode rejects $ref placeholders explicitly instead of dispatching literals", async () => {
    const gateway = new MCPGateway({ profileRegistry: profileRegistryWithLabeledVault() });
    const build = createAgentPolicyGateway({
      gateway,
      toolDescriptors: [searchEntry, sendEntry],
      serverId: SERVER,
    });
    const agent = new ToolCallingAgent({
      model: scriptedModel([
        {
          calls: [
            { id: "c1", name: "search_docs", input: { key: "k" } },
            { id: "c2", name: "send_report", input: { body: "$c1" } },
          ],
        },
        { text: "done" },
      ]) as any,
      tools: coreTools(),
      maxSteps: 8,
      scheduler: "parallel",
      policyGateway: build({ traceId: "trace-parallel-ref" }) as unknown as RunPolicyGateway,
    });
    const events: any[] = [];
    for await (const e of agent.run("probe parallel ref")) events.push(e);

    // c1 executed; c2 refused with an explicit error (not a literal body).
    expect(sendCalls).toBe(0);
    const result = events.find((e) => e.event === "tool_result" && e.data?.callId === "c2");
    expect(JSON.stringify(result?.data?.error)).toContain("$ref");
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
  });
});

describe("agent-loop provenance wiring (IF-07c) — ledger bound", () => {
  it("caps the run ledger: the oldest entry is evicted on overflow", async () => {
    const gateway = new MCPGateway({ profileRegistry: profileRegistryWithLabeledVault() });
    const build = createAgentPolicyGateway({
      gateway,
      toolDescriptors: [searchEntry, sendEntry],
      serverId: SERVER,
    });
    const gw: RunPolicyGateway = build({ traceId: "trace-cap-test" });
    // Mint 600 labeled observations: each search_docs decision carries
    // resultTaintLabels ["secret"], so each observed output enters the ledger.
    for (let i = 0; i < 600; i++) {
      gw.evaluateBeforeCall({ callId: `vc-${i}`, toolName: "search_docs", args: { key: "k" } });
      gw.observeResult({
        callId: `vc-${i}`,
        toolName: "search_docs",
        output: `secret-value-${i}`,
        isError: false,
      });
    }
    // The ledger holds ~512 sensitive observations, so the label rule denies
    // send_report either way — the IDENTITY rule's presence is the signal:
    // observation 0 was evicted (all entries sensitive → oldest first), so an
    // arg matching secret-value-0 no longer trips the identity rule…
    const evicted = gw.evaluateBeforeCall({
      callId: "check-evicted",
      toolName: "send_report",
      args: { payload: "secret-value-0" },
    });
    expect(evicted.action).toBe("deny");
    expect(evicted.ruleIds).not.toContain("sink-tainted-identity-deny");
    // …while the newest observation still does.
    const retained = gw.evaluateBeforeCall({
      callId: "check-retained",
      toolName: "send_report",
      args: { payload: "secret-value-599" },
    });
    expect(retained.action).toBe("deny");
    expect(retained.ruleIds).toContain("sink-tainted-identity-deny");
  });
});
