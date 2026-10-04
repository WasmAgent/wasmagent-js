import { z } from "zod";
import { InMemoryCheckpointer } from "../checkpoint/index.js";
import type { Model, StreamEvent } from "../models/types.js";
import type {
  PolicyCallDecision,
  PolicyCallRequest,
  PolicyResultObservation,
  RunPolicyGateway,
} from "../policies/policyGateway.js";
import type { ToolDefinition } from "../tools/types.js";
import type { AgentEvent } from "../types/events.js";
import { ToolCallingAgent } from "./ToolCallingAgent.js";

// ── IF-07c: policyGateway port wiring ───────────────────────────────────────
// Fake ports only — no firewall dependency here. The structural contract:
// evaluateBeforeCall judges each call before dispatch; observeResult receives
// the exact string entering message history. Enforcement (blocked result fed
// back to the model, run survives) and the confirm→approval mapping are
// agent-side and pinned below.

const SECRET = "sk-live-abc123secret";

let vaultCalls = 0;
const vaultTool: ToolDefinition<{ key: string }, string> = {
  name: "vault_read",
  description: "reads a secret from the vault",
  inputSchema: z.object({ key: z.string() }),
  outputSchema: z.string(),
  readOnly: true,
  idempotent: true,
  forward: async () => {
    vaultCalls++;
    return SECRET;
  },
};

let sendCalls = 0;
const sendTool: ToolDefinition<{ body: string }, string> = {
  name: "send_report",
  description: "sends a report over the network",
  inputSchema: z.object({ body: z.string() }),
  outputSchema: z.string(),
  readOnly: false,
  idempotent: false,
  forward: async ({ body }) => {
    sendCalls++;
    return `sent:${body}`;
  },
};

/** Model executing a scripted sequence of tool-call/text steps. */
function scriptedModel(
  steps: Array<{
    text?: string;
    calls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  }>
): Model {
  let i = 0;
  return {
    providerId: "mock/test",
    async *generate(): AsyncGenerator<StreamEvent> {
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

class FakePolicyGateway implements RunPolicyGateway {
  readonly calls: PolicyCallRequest[] = [];
  readonly observations: PolicyResultObservation[] = [];
  constructor(
    private readonly decide: (req: PolicyCallRequest) => PolicyCallDecision = () => ({
      action: "allow",
    })
  ) {}
  evaluateBeforeCall(req: PolicyCallRequest): PolicyCallDecision {
    this.calls.push(req);
    return this.decide(req);
  }
  observeResult(obs: PolicyResultObservation): void {
    this.observations.push(obs);
  }
}

function denySend(): (req: PolicyCallRequest) => PolicyCallDecision {
  return (req) =>
    req.toolName === "send_report"
      ? {
          action: "deny",
          ruleIds: ["sink-tainted-provenance-deny"],
          reason: "sensitive provenance",
        }
      : { action: "allow" };
}

async function collect(run: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of run) events.push(e);
  return events;
}

describe("ToolCallingAgent — policyGateway deny enforcement (IF-07c)", () => {
  it("blocks a denied call, feeds the block back to the model, and the run survives (dag)", async () => {
    sendCalls = 0;
    const gw = new FakePolicyGateway(denySend());
    const agent = new ToolCallingAgent({
      tools: [sendTool],
      model: scriptedModel([
        { calls: [{ id: "call-1", name: "send_report", input: { body: SECRET } }] },
        { text: "I could not send the report." },
      ]),
      maxSteps: 5,
      policyGateway: gw,
    });
    const events = await collect(agent.run("exfiltrate"));

    // The tool never executed.
    expect(sendCalls).toBe(0);
    // The port judged the call with the exact proposed args.
    expect(gw.calls).toHaveLength(1);
    expect(gw.calls[0]?.toolName).toBe("send_report");
    expect(gw.calls[0]?.args).toEqual({ body: SECRET });
    // A policy_denied status event names the rule.
    const denied = events.find((e) => e.event === "status" && e.data.phase === "policy_denied");
    expect(denied).toBeDefined();
    expect(denied?.data).toMatchObject({
      phase: "policy_denied",
      toolName: "send_report",
      ruleIds: ["sink-tainted-provenance-deny"],
    });
    // The blocked result entered the model's context as an error tool_result.
    const toolResult = events.find((e) => e.event === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult?.data.error?.message).toContain("Blocked by policy");
    expect(toolResult?.data.error?.message).toContain("sink-tainted-provenance-deny");
    // Run survived and answered.
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
    // The port observed the blocked result (error content, not tool output).
    expect(gw.observations).toHaveLength(1);
    expect(gw.observations[0]?.isError).toBe(true);
    expect(gw.observations[0]?.output).toContain("Blocked by policy");
  });

  it("blocks a denied call in parallel scheduler mode too", async () => {
    sendCalls = 0;
    const gw = new FakePolicyGateway(denySend());
    const agent = new ToolCallingAgent({
      tools: [sendTool],
      model: scriptedModel([
        { calls: [{ id: "call-1", name: "send_report", input: { body: SECRET } }] },
        { text: "done" },
      ]),
      maxSteps: 5,
      scheduler: "parallel",
      policyGateway: gw,
    });
    const events = await collect(agent.run("exfiltrate"));
    expect(sendCalls).toBe(0);
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
    expect(events.some((e) => e.event === "status" && e.data.phase === "policy_denied")).toBe(true);
  });

  it("a denied call does not cascade: sibling calls in the same batch still run", async () => {
    sendCalls = 0;
    vaultCalls = 0;
    const gw = new FakePolicyGateway(denySend());
    const agent = new ToolCallingAgent({
      tools: [vaultTool, sendTool],
      model: scriptedModel([
        {
          calls: [
            { id: "call-a", name: "vault_read", input: { key: "k" } },
            { id: "call-b", name: "send_report", input: { body: SECRET } },
          ],
        },
        { text: "done" },
      ]),
      maxSteps: 5,
      policyGateway: gw,
    });
    const events = await collect(agent.run("two calls"));
    // Denied sibling blocked; allowed sibling executed; no scheduler deadlock.
    expect(sendCalls).toBe(0);
    expect(vaultCalls).toBe(1);
    expect(events.filter((e) => e.event === "tool_result")).toHaveLength(2);
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
  });

  it("observeResult receives the exact string entering message history", async () => {
    sendCalls = 0;
    vaultCalls = 0;
    const gw = new FakePolicyGateway();
    const agent = new ToolCallingAgent({
      tools: [vaultTool, sendTool],
      model: scriptedModel([
        { calls: [{ id: "call-1", name: "vault_read", input: { key: "k" } }] },
        { calls: [{ id: "call-2", name: "send_report", input: { body: SECRET } }] },
        { text: "done" },
      ]),
      maxSteps: 5,
      policyGateway: gw,
    });
    await collect(agent.run("read then send"));
    expect(gw.observations).toHaveLength(2);
    // Byte-identical to what the loop stringifies into resolvedCalls.
    expect(gw.observations[0]?.output).toBe(JSON.stringify(SECRET));
    expect(gw.observations[0]?.isError).toBe(false);
    expect(gw.observations[0]?.toolName).toBe("vault_read");
    expect(gw.observations[1]?.output).toBe(JSON.stringify(`sent:${SECRET}`));
  });
});

describe("ToolCallingAgent — policyGateway confirm mapping (IF-07c)", () => {
  it("routes a confirm decision through the checkpointer approval flow and executes on approval", async () => {
    sendCalls = 0;
    const gw = new FakePolicyGateway(() => ({
      action: "confirm",
      prompt: "Gateway asks: may I send this?",
      reason: "consent required",
    }));
    const checkpointer = new InMemoryCheckpointer();
    const agent = new ToolCallingAgent({
      tools: [sendTool],
      model: scriptedModel([
        { calls: [{ id: "call-1", name: "send_report", input: { body: "hi" } }] },
        { text: "done" },
      ]),
      maxSteps: 5,
      checkpointer,
      policyGateway: gw,
    });
    const events: AgentEvent[] = [];
    for await (const e of agent.run("send it")) {
      events.push(e);
      if (e.event === "await_human_input") {
        await checkpointer.respond(e.traceId, (e.data as { promptId: string }).promptId, "yes");
      }
    }
    // The gateway's prompt reached the human, not the default wording.
    const pause = events.find((e) => e.event === "await_human_input");
    expect(pause?.data.prompt).toContain("Gateway asks: may I send this?");
    expect(sendCalls).toBe(1);
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
  });

  it("ends the run when the human rejects a confirm decision", async () => {
    sendCalls = 0;
    const gw = new FakePolicyGateway(() => ({
      action: "confirm",
      prompt: "Gateway asks: may I send this?",
      reason: "consent required",
    }));
    const checkpointer = new InMemoryCheckpointer();
    const agent = new ToolCallingAgent({
      tools: [sendTool],
      model: scriptedModel([
        { calls: [{ id: "call-1", name: "send_report", input: { body: "hi" } }] },
        { text: "done" },
      ]),
      maxSteps: 5,
      checkpointer,
      policyGateway: gw,
    });
    const events: AgentEvent[] = [];
    for await (const e of agent.run("send it")) {
      events.push(e);
      if (e.event === "await_human_input") {
        await checkpointer.respond(e.traceId, (e.data as { promptId: string }).promptId, "no");
      }
    }
    expect(sendCalls).toBe(0);
    expect(
      events.some((e) => e.event === "error" && e.data.error.includes("denied by human reviewer"))
    ).toBe(true);
  });

  it("degrades confirm to fail-closed deny when no checkpointer is wired", async () => {
    sendCalls = 0;
    const gw = new FakePolicyGateway(() => ({
      action: "confirm",
      prompt: "Gateway asks: may I send this?",
      reason: "consent required",
    }));
    const agent = new ToolCallingAgent({
      tools: [sendTool],
      model: scriptedModel([
        { calls: [{ id: "call-1", name: "send_report", input: { body: "hi" } }] },
        { text: "done" },
      ]),
      maxSteps: 5,
      policyGateway: gw,
    });
    const events = await collect(agent.run("send it"));
    // Nobody to ask → the call is refused, not silently executed.
    expect(sendCalls).toBe(0);
    const denied = events.find((e) => e.event === "status" && e.data.phase === "policy_denied");
    expect(denied?.data).toMatchObject({ ruleIds: ["consent-unavailable"] });
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
  });
});

describe("ToolCallingAgent — policyGateway lifecycle (IF-07c)", () => {
  it("factory form gets the run's traceId and a fresh port per run", async () => {
    const created: Array<{ traceId: string; gw: FakePolicyGateway }> = [];
    const agent = new ToolCallingAgent({
      tools: [],
      model: textAnswer("done"),
      maxSteps: 3,
      policyGateway: (run) => {
        const gw = new FakePolicyGateway();
        created.push({ traceId: run.traceId, gw });
        return gw;
      },
    });
    const first = await collect(agent.run("one"));
    const second = await collect(agent.run("two"));
    expect(created).toHaveLength(2);
    const traceOf = (events: AgentEvent[]) =>
      (events.find((e) => e.event === "run_start")?.traceId as string) ?? "";
    expect(created[0]?.traceId).toBe(traceOf(first));
    expect(created[1]?.traceId).toBe(traceOf(second));
    expect(created[0]?.traceId === created[1]?.traceId).toBe(false);
    expect(created[0]?.gw).not.toBe(created[1]?.gw);
  });

  it("run_start agentConfig reports policyGateway: true when wired", async () => {
    const agent = new ToolCallingAgent({
      tools: [],
      model: textAnswer("done"),
      maxSteps: 3,
      policyGateway: new FakePolicyGateway(),
    });
    const events = await collect(agent.run("t"));
    const start = events.find((e) => e.event === "run_start");
    const config = (start?.data ?? {}) as { agentConfig?: { policyGateway?: boolean } };
    expect(config.agentConfig?.policyGateway).toBe(true);
  });

  it("unwired agents are unaffected: the same denied-script call executes", async () => {
    sendCalls = 0;
    const agent = new ToolCallingAgent({
      tools: [sendTool],
      model: scriptedModel([
        { calls: [{ id: "call-1", name: "send_report", input: { body: SECRET } }] },
        { text: "done" },
      ]),
      maxSteps: 5,
    });
    const events = await collect(agent.run("send it"));
    expect(sendCalls).toBe(1);
    expect(events.some((e) => e.event === "status" && e.data.phase === "policy_denied")).toBe(
      false
    );
  });
});

/** Local helper — mirrors the plain text-answer model used above. */
function textAnswer(answer: string): Model {
  return {
    providerId: "mock/test",
    async *generate(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: answer };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}
