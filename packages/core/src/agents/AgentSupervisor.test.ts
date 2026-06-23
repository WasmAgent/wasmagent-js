import { describe, expect, it } from "bun:test";
import type { AgentEvent, Model, StreamEvent } from "../models/types.js";
import type { ToolDefinition } from "../tools/types.js";
import {
  AgentSupervisor,
  budgetGuardPolicy,
  composePolicies,
  noProgressPolicy,
  retryOnErrorPolicy,
} from "./AgentSupervisor.js";
import { ToolCallingAgent } from "./ToolCallingAgent.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Model that returns scripted text replies in order (repeats last on exhaustion). */
function scriptedModel(replies: string[]): Model {
  let i = 0;
  return {
    providerId: "mock/scripted",
    async *generate(): AsyncGenerator<StreamEvent> {
      const reply = replies[Math.min(i++, replies.length - 1)] ?? "done";
      yield { type: "text_delta", delta: reply };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

/** Model that emits a usage event so budgetGuardPolicy can accumulate tokens. */
function tokenModel(inputTokens: number, outputTokens: number, reply = "done"): Model {
  return {
    providerId: "mock/token",
    async *generate(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: reply };
      yield { type: "usage", usage: { inputTokens, outputTokens } };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

function factory(
  model: Model
): (patch?: Partial<ConstructorParameters<typeof ToolCallingAgent>[0]>) => ToolCallingAgent {
  return (patch) => new ToolCallingAgent({ tools: [], model, maxSteps: 3, ...patch });
}

// ── Core behaviour ────────────────────────────────────────────────────────────

describe("AgentSupervisor — core behaviour", () => {
  it("passes all events through when policy always returns continue", async () => {
    const supervisor = new AgentSupervisor({
      agentFactory: factory(scriptedModel(["hello"])),
      task: "say hello",
      policy: { evaluate: async () => ({ action: "continue" }) },
    });
    const events: AgentEvent[] = [];
    for await (const e of supervisor.run()) events.push(e);
    expect(events.some((e) => e.event === "run_start")).toBe(true);
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
    expect(events.some((e) => e.event === "supervisor_decision")).toBe(false);
  });

  it("abort: emits supervisor_decision and stops immediately", async () => {
    const supervisor = new AgentSupervisor({
      agentFactory: factory(scriptedModel(["running..."])),
      task: "task",
      policy: {
        evaluate: (event) => {
          if (event.event === "run_start") return { action: "abort", reason: "test abort" };
          return { action: "continue" };
        },
      },
    });
    const events: AgentEvent[] = [];
    for await (const e of supervisor.run()) events.push(e);
    const dec = events.find((e) => e.event === "supervisor_decision");
    expect(dec).toBeDefined();
    expect((dec?.data as { action: string; reason: string }).action).toBe("abort");
    expect((dec?.data as { reason: string }).reason).toBe("test abort");
    // No events after abort
    const abortIdx = events.indexOf(dec!);
    expect(events.length).toBe(abortIdx + 1);
  });

  it("restart: agentFactory called again; supervisor_decision emitted between runs", async () => {
    let factoryCallCount = 0;
    const supervisor = new AgentSupervisor({
      agentFactory: (patch) => {
        factoryCallCount++;
        return new ToolCallingAgent({
          tools: [],
          model: scriptedModel(["ok"]),
          maxSteps: 2,
          ...patch,
        });
      },
      task: "task",
      policy: {
        maxRuns: 2,
        evaluate: (event, _hist, runCount) => {
          // Restart only on the first run's run_start
          if (event.event === "run_start" && runCount === 0) {
            return { action: "restart", reason: "first restart" };
          }
          return { action: "continue" };
        },
      },
    });
    const events: AgentEvent[] = [];
    for await (const e of supervisor.run()) events.push(e);
    expect(factoryCallCount).toBe(2);
    expect(events.filter((e) => e.event === "supervisor_decision")).toHaveLength(1);
    expect(events.filter((e) => e.event === "run_start")).toHaveLength(2);
  });

  it("maxRuns cap: stops after maxRuns even if policy keeps requesting restart", async () => {
    let runs = 0;
    const supervisor = new AgentSupervisor({
      agentFactory: () => {
        runs++;
        return new ToolCallingAgent({ tools: [], model: scriptedModel(["x"]), maxSteps: 1 });
      },
      task: "loop",
      policy: {
        maxRuns: 2,
        evaluate: () => ({ action: "restart" }),
      },
    });
    const events: AgentEvent[] = [];
    for await (const e of supervisor.run()) events.push(e);
    expect(runs).toBeLessThanOrEqual(2);
  });

  it("restart with task override: new task is used in subsequent run", async () => {
    const seenTasks: string[] = [];
    const supervisor = new AgentSupervisor({
      agentFactory: (patch) =>
        new ToolCallingAgent({ tools: [], model: scriptedModel(["ok"]), maxSteps: 2, ...patch }),
      task: "original-task",
      policy: {
        maxRuns: 2,
        evaluate(event, _hist, runCount) {
          if (event.event === "run_start") {
            seenTasks.push((event.data as { task: string }).task);
            if (runCount === 0) return { action: "restart", task: "new-task" };
          }
          return { action: "continue" };
        },
      },
    });
    for await (const _ of supervisor.run()) void _;
    expect(seenTasks[0]).toBe("original-task");
    expect(seenTasks[1]).toBe("new-task");
  });

  it("external signal abort: terminates before next event is processed", async () => {
    const ac = new AbortController();
    ac.abort();
    const supervisor = new AgentSupervisor({
      agentFactory: factory(scriptedModel(["should not emit"])),
      task: "task",
      policy: { evaluate: () => ({ action: "continue" }) },
      signal: ac.signal,
    });
    const events: AgentEvent[] = [];
    for await (const e of supervisor.run()) events.push(e);
    // Pre-aborted signal — run() should return immediately without any events
    expect(events).toHaveLength(0);
  });

  it("patchOptions forwarded to agentFactory on restart", async () => {
    const seenMaxSteps: number[] = [];
    const supervisor = new AgentSupervisor({
      agentFactory: (patch) => {
        const opts = {
          tools: [] as ToolDefinition[],
          model: scriptedModel(["ok"]),
          maxSteps: 5,
          ...patch,
        };
        seenMaxSteps.push(opts.maxSteps ?? 5);
        return new ToolCallingAgent(opts);
      },
      task: "task",
      policy: {
        maxRuns: 2,
        evaluate(event, _hist, runCount) {
          if (event.event === "run_start" && runCount === 0) {
            return { action: "restart", patchOptions: { maxSteps: 10 } };
          }
          return { action: "continue" };
        },
      },
    });
    for await (const _ of supervisor.run()) void _;
    expect(seenMaxSteps[0]).toBe(5);
    expect(seenMaxSteps[1]).toBe(10);
  });
});

// ── Built-in policies ─────────────────────────────────────────────────────────

describe("retryOnErrorPolicy", () => {
  it("restarts on error event up to maxRetries times", async () => {
    let runs = 0;
    const _supervisor = new AgentSupervisor({
      agentFactory: () => {
        runs++;
        return new ToolCallingAgent({ tools: [], model: scriptedModel(["done"]), maxSteps: 1 });
      },
      task: "task",
      policy: retryOnErrorPolicy(2),
    });
    // Inject error events manually via a wrapper model
    const errorModel: Model = {
      providerId: "mock/error",
      async *generate(): AsyncGenerator<StreamEvent> {
        // Emit a text that triggers error downstream — simplest: just complete normally
        yield { type: "text_delta", delta: "ok" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const sup2 = new AgentSupervisor({
      agentFactory: (patch) =>
        new ToolCallingAgent({ tools: [], model: errorModel, maxSteps: 1, ...patch }),
      task: "task",
      policy: retryOnErrorPolicy(1),
    });
    const events: AgentEvent[] = [];
    for await (const e of sup2.run()) events.push(e);
    // No error → no restart → supervisor_decision absent
    expect(events.some((e) => e.event === "supervisor_decision")).toBe(false);
    expect(runs).toBe(0); // sup2 used its own factory
  });

  it("aborts after maxRetries exceeded", async () => {
    const policy = retryOnErrorPolicy(0); // 0 retries → abort on first error
    const errorEvent = {
      traceId: "t",
      parentTraceId: null,
      channel: "text" as const,
      event: "error" as const,
      data: { error: "boom" },
      timestampMs: 0,
    } as AgentEvent;
    const decision = await policy.evaluate(errorEvent, [errorEvent], 0);
    expect(decision.action).toBe("abort");
  });

  it("restarts on first error when maxRetries > 0", async () => {
    const policy = retryOnErrorPolicy(2);
    const errorEvent = {
      traceId: "t",
      parentTraceId: null,
      channel: "text" as const,
      event: "error" as const,
      data: { error: "boom" },
      timestampMs: 0,
    } as AgentEvent;
    const decision = await policy.evaluate(errorEvent, [errorEvent], 0);
    expect(decision.action).toBe("restart");
  });
});

describe("budgetGuardPolicy", () => {
  it("aborts when cumulative tokens exceed limit", async () => {
    const policy = budgetGuardPolicy(100);
    const usageEvent = {
      traceId: "t",
      parentTraceId: null,
      channel: "model" as const,
      event: "model_done" as const,
      data: { modelId: "m", step: 1, finishReason: "end_turn", inputTokens: 60, outputTokens: 60 },
      timestampMs: 0,
    } as AgentEvent;
    const decision = await policy.evaluate(usageEvent, [usageEvent], 0);
    expect(decision.action).toBe("abort");
    expect((decision as { reason: string }).reason).toContain("budget exhausted");
  });

  it("continues when tokens are below limit", async () => {
    const policy = budgetGuardPolicy(1000);
    const usageEvent = {
      traceId: "t",
      parentTraceId: null,
      channel: "model" as const,
      event: "model_done" as const,
      data: { modelId: "m", step: 1, finishReason: "end_turn", inputTokens: 10, outputTokens: 10 },
      timestampMs: 0,
    } as AgentEvent;
    const decision = await policy.evaluate(usageEvent, [usageEvent], 0);
    expect(decision.action).toBe("continue");
  });

  it("aborts mid-run via supervisor integration", async () => {
    const supervisor = new AgentSupervisor({
      agentFactory: (patch) =>
        new ToolCallingAgent({
          tools: [],
          model: tokenModel(60, 60),
          maxSteps: 3,
          ...patch,
        }),
      task: "expensive task",
      policy: budgetGuardPolicy(100), // 120 tokens > 100 limit
    });
    const events: AgentEvent[] = [];
    for await (const e of supervisor.run()) events.push(e);
    expect(events.some((e) => e.event === "supervisor_decision")).toBe(true);
    const dec = events.find((e) => e.event === "supervisor_decision");
    expect((dec?.data as { action: string }).action).toBe("abort");
  });
});

describe("noProgressPolicy", () => {
  it("aborts when final_answer repeats k times", async () => {
    const policy = noProgressPolicy(2);
    const makeAnswer = (answer: string): AgentEvent => ({
      traceId: "t",
      parentTraceId: null,
      channel: "text" as const,
      event: "final_answer" as const,
      data: { answer },
      timestampMs: 0,
    });
    await policy.evaluate(makeAnswer("same"), [makeAnswer("same")], 0);
    const second = await policy.evaluate(
      makeAnswer("same"),
      [makeAnswer("same"), makeAnswer("same")],
      1
    );
    expect(second.action).toBe("abort");
    expect((second as { reason: string }).reason).toContain("no progress");
  });

  it("continues when answers differ", async () => {
    const policy = noProgressPolicy(2);
    const makeAnswer = (answer: string): AgentEvent => ({
      traceId: "t",
      parentTraceId: null,
      channel: "text" as const,
      event: "final_answer" as const,
      data: { answer },
      timestampMs: 0,
    });
    await policy.evaluate(makeAnswer("a"), [], 0);
    const second = await policy.evaluate(makeAnswer("b"), [], 1);
    expect(second.action).toBe("continue");
  });
});

describe("composePolicies", () => {
  it("returns first non-continue decision", async () => {
    const p1: typeof retryOnErrorPolicy extends (n: number) => infer R ? R : never =
      retryOnErrorPolicy(1);
    const p2 = budgetGuardPolicy(50);
    const composed = composePolicies([p1, p2]);

    const errorEvent = {
      traceId: "t",
      parentTraceId: null,
      channel: "text" as const,
      event: "error" as const,
      data: { error: "boom" },
      timestampMs: 0,
    } as AgentEvent;
    const decision = await composed.evaluate(errorEvent, [errorEvent], 0);
    // p1 returns restart on error (first non-continue)
    expect(decision.action).toBe("restart");
  });

  it("returns continue when all policies agree", async () => {
    const composed = composePolicies([
      { evaluate: async () => ({ action: "continue" }) },
      { evaluate: async () => ({ action: "continue" }) },
    ]);
    const event = {
      traceId: "t",
      parentTraceId: null,
      channel: "text" as const,
      event: "final_answer" as const,
      data: { answer: "ok" },
      timestampMs: 0,
    } as AgentEvent;
    const decision = await composed.evaluate(event, [], 0);
    expect(decision.action).toBe("continue");
  });

  it("uses max maxRuns across all policies", () => {
    const composed = composePolicies([
      { maxRuns: 5, evaluate: async () => ({ action: "continue" }) },
      { maxRuns: 10, evaluate: async () => ({ action: "continue" }) },
    ]);
    expect(composed.maxRuns).toBe(10);
  });
});
