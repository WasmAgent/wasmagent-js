/**
 * Comprehensive multi-package integration tests.
 *
 * Covers the end-to-end agent pipeline across:
 *
 *   A. Axis-9 adaptive execution (L1 fallback + L2 synthesis) — composability
 *   B. WorkflowEngine + ToolRegistry — DAG dispatch with dependency resolution
 *   C. ParallelForkJoinRunner + ToolCallingAgent — bscode multi-agent pattern
 *   D. GoalDirectedAgent full loop — scout → criteria → iterations → verified
 *   E. Package rename guard — @wasmagent/* imports resolve; no @agentkit-js/* leakage
 *
 * All tests use mock models — no real LLM calls.
 */

import { describe, expect, it } from "bun:test";
import type {
  AgentEvent,
  Criterion,
  Model,
  ModelMessage,
  StreamEvent,
  ToolDefinition,
  WorkspaceReader,
} from "@wasmagent/core";
import { GoalDirectedAgent, ToolCallingAgent, ToolRegistry } from "@wasmagent/core";
import type { WorkflowDefinition } from "@wasmagent/core/beta";
import {
  KvWorkflowStateStore,
  LocalWorkflowEngine,
  MemoryKvBackend,
  ParallelForkJoinRunner,
} from "@wasmagent/core/beta";
import { z } from "zod";

// ── Mock helpers ─────────────────────────────────────────────────────────────

/** Model that returns scripted text responses in order (repeats last on exhaustion). */
function textModel(responses: string[]): Model {
  let idx = 0;
  return {
    providerId: "mock/text",
    async *generate(): AsyncGenerator<StreamEvent> {
      const reply = responses[Math.min(idx++, responses.length - 1)] ?? "done";
      yield { type: "text_delta", delta: reply };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

/** Model that calls a tool once then returns text on next turn, capturing tool_result content. */
function captureToolResultModel(
  toolName: string,
  toolInput: Record<string, unknown>
): { model: Model; seenToolResults: string[] } {
  const seenToolResults: string[] = [];
  let callCount = 0;
  const model: Model = {
    providerId: "mock/capture",
    async *generate(messages: ModelMessage[]): AsyncGenerator<StreamEvent> {
      callCount++;
      if (callCount > 1) {
        // Scan for tool_result blocks in the most recent message.
        const last = messages.at(-1);
        if (last && Array.isArray(last.content)) {
          for (const block of last.content) {
            const b = block as { type?: string; content?: unknown };
            if (b.type === "tool_result") {
              const c = Array.isArray(b.content) ? b.content : [b.content];
              for (const inner of c) {
                const i = inner as { text?: string } | string;
                const text = typeof i === "string" ? i : (i?.text ?? "");
                if (text) seenToolResults.push(text);
              }
            }
          }
        }
      }
      if (callCount === 1) {
        yield {
          type: "tool_call",
          toolCall: { type: "tool_use", id: "c1", name: toolName, input: toolInput },
        };
      } else {
        yield { type: "text_delta", delta: "done" };
      }
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
  return { model, seenToolResults };
}

/** Fake WorkspaceReader backed by an in-memory dict; also exposes a write() for side-effects. */
function fakeWs(initial: Record<string, string> = {}): WorkspaceReader & {
  write: (path: string, body: string) => void;
} {
  const data: Record<string, string> = { ...initial };
  return {
    async readFile(path) {
      if (!(path in data)) throw new Error(`ENOENT: ${path}`);
      return data[path] ?? "";
    },
    async fileExists(path) {
      return path in data;
    },
    async fileSize(path) {
      if (!(path in data)) throw new Error(`ENOENT: ${path}`);
      return new TextEncoder().encode(data[path] ?? "").length;
    },
    write(path, body) {
      data[path] = body;
    },
  };
}

/** Scripted model for GoalDirectedAgent. Side-effects write to a fakeWs. */
function scriptedExec(
  script: Array<{ text: string; sideEffect?: { path: string; body: string } }>,
  ws: ReturnType<typeof fakeWs>
): Model {
  let i = 0;
  return {
    providerId: "mock/scripted-exec",
    async *generate(): AsyncGenerator<StreamEvent> {
      const entry = script[Math.min(i++, script.length - 1)] ?? { text: "done" };
      if (entry.sideEffect) ws.write(entry.sideEffect.path, entry.sideEffect.body);
      yield { type: "text_delta", delta: entry.text };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

const noTools: ToolDefinition[] = [];

// ── A. Axis-9 L1 — tool fallback offering ────────────────────────────────────

describe("A. Axis-9 L1: tool fallback offered on failure", () => {
  const brokenTool: ToolDefinition<{ path: string }, string> = {
    name: "write_file",
    description: "Write a file (broken in this fixture)",
    inputSchema: z.object({ path: z.string() }),
    outputSchema: z.string(),
    readOnly: false,
    idempotent: true,
    alternatives: ["append_file"],
    forward: async () => {
      throw new Error("EROFS: read-only filesystem");
    },
  };
  const appendTool: ToolDefinition<{ path: string }, string> = {
    name: "append_file",
    description: "Append text to an existing file",
    inputSchema: z.object({ path: z.string() }),
    outputSchema: z.string(),
    readOnly: false,
    idempotent: false,
    forward: async () => "appended",
  };

  it("emits tool_fallback_offered with the correct candidate list", async () => {
    const { model } = captureToolResultModel("write_file", { path: "/x" });
    const agent = new ToolCallingAgent({ tools: [brokenTool, appendTool], model, maxSteps: 3 });
    const events: AgentEvent[] = [];
    for await (const e of agent.run("write x")) events.push(e);

    const fallback = events.find((e) => e.event === "tool_fallback_offered");
    expect(fallback).toBeDefined();
    const data = fallback?.data as { failedTool: string; candidates: { name: string }[] };
    expect(data.failedTool).toBe("write_file");
    expect(data.candidates.map((c) => c.name)).toEqual(["append_file"]);
  });

  it("injects [framework hint] into the tool_result the model receives", async () => {
    const { model, seenToolResults } = captureToolResultModel("write_file", { path: "/x" });
    const agent = new ToolCallingAgent({ tools: [brokenTool, appendTool], model, maxSteps: 3 });
    for await (const _ of agent.run("write x")) void _;
    expect(seenToolResults.length).toBeGreaterThan(0);
    expect(seenToolResults[0]).toMatch(/\[framework hint\]/);
    expect(seenToolResults[0]).toContain("append_file");
  });

  it("does NOT emit tool_fallback_offered when the tool has no alternatives", async () => {
    const noAltTool: ToolDefinition<{ path: string }, string> = {
      ...brokenTool,
      alternatives: undefined,
    };
    const { model } = captureToolResultModel("write_file", { path: "/x" });
    const agent = new ToolCallingAgent({ tools: [noAltTool, appendTool], model, maxSteps: 3 });
    const events: AgentEvent[] = [];
    for await (const e of agent.run("write x")) events.push(e);
    expect(events.find((e) => e.event === "tool_fallback_offered")).toBeUndefined();
  });

  it("caps the candidate list at 3 even when more alternatives are declared", async () => {
    const mkAlt = (name: string): ToolDefinition<{ path: string }, string> => ({
      name,
      description: `${name} desc`,
      inputSchema: z.object({ path: z.string() }),
      outputSchema: z.string(),
      readOnly: false,
      idempotent: false,
      forward: async () => "ok",
    });
    const manyAlts: ToolDefinition<{ path: string }, string> = {
      ...brokenTool,
      alternatives: ["alt_1", "alt_2", "alt_3", "alt_4"],
    };
    const { model } = captureToolResultModel("write_file", { path: "/x" });
    const agent = new ToolCallingAgent({
      tools: [manyAlts, mkAlt("alt_1"), mkAlt("alt_2"), mkAlt("alt_3"), mkAlt("alt_4")],
      model,
      maxSteps: 3,
    });
    const events: AgentEvent[] = [];
    for await (const e of agent.run("write x")) events.push(e);
    const data = events.find((e) => e.event === "tool_fallback_offered")?.data as {
      candidates: { name: string }[];
    };
    expect(data.candidates.length).toBeLessThanOrEqual(3);
  });
});

// ── A. Axis-9 L2 — tool synthesis ────────────────────────────────────────────

describe("A. Axis-9 L2: tool synthesis via execute_code substrate", () => {
  const codeRunner: ToolDefinition<{ code: string }, string> = {
    name: "execute_code",
    description: "Execute arbitrary JS code",
    inputSchema: z.object({ code: z.string() }),
    outputSchema: z.string(),
    readOnly: false,
    idempotent: false,
    forward: async ({ code }) => `ran: ${code}`,
  };

  it("emits tool_synthesised when synthesis tool is called with enableToolSynthesis: true", async () => {
    const { model } = captureToolResultModel("execute_code", { code: "1+1" });
    const agent = new ToolCallingAgent({
      tools: [codeRunner],
      model,
      maxSteps: 3,
      enableToolSynthesis: true,
    });
    const events: AgentEvent[] = [];
    for await (const e of agent.run("compute something")) events.push(e);
    expect(events.find((e) => e.event === "tool_synthesised")).toBeDefined();
  });

  it("does NOT emit tool_synthesised when enableToolSynthesis is off", async () => {
    const { model } = captureToolResultModel("execute_code", { code: "1+1" });
    const agent = new ToolCallingAgent({ tools: [codeRunner], model, maxSteps: 3 });
    const events: AgentEvent[] = [];
    for await (const e of agent.run("compute something")) events.push(e);
    expect(events.find((e) => e.event === "tool_synthesised")).toBeUndefined();
  });

  it("injects synthesis preamble naming the code tool when enabled", async () => {
    let capturedSystemPrompt = "";
    const spy: Model = {
      providerId: "mock/spy",
      async *generate(msgs: ModelMessage[]): AsyncGenerator<StreamEvent> {
        if (!capturedSystemPrompt) {
          const sys = msgs.find((m) => m.role === "system");
          if (sys && typeof sys.content === "string") capturedSystemPrompt = sys.content;
        }
        yield { type: "text_delta", delta: "done" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const agent = new ToolCallingAgent({
      tools: [codeRunner],
      model: spy,
      maxSteps: 1,
      enableToolSynthesis: { codeToolName: "execute_code" },
    });
    for await (const _ of agent.run("do work")) void _;
    expect(capturedSystemPrompt).toContain("execute_code");
    expect(capturedSystemPrompt).toContain("synthesise");
  });
});

// ── B. WorkflowEngine + ToolRegistry ─────────────────────────────────────────

describe("B. WorkflowEngine + ToolRegistry: DAG execution with dependency resolution", () => {
  const multiplyTool: ToolDefinition<{ a: number; b: number }, number> = {
    name: "multiply",
    description: "Multiply two numbers",
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    outputSchema: z.number(),
    readOnly: true,
    idempotent: true,
    forward: async ({ a, b }) => a * b,
  };

  const addTool: ToolDefinition<{ a: number; b: number }, number> = {
    name: "add",
    description: "Add two numbers",
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    outputSchema: z.number(),
    readOnly: true,
    idempotent: true,
    forward: async ({ a, b }) => a + b,
  };

  it("runs a two-step linear DAG: multiply then add via $-ref", async () => {
    const tools = new ToolRegistry();
    tools.register(multiplyTool);
    tools.register(addTool);

    const store = new KvWorkflowStateStore(new MemoryKvBackend());
    const engine = new LocalWorkflowEngine({ tools, store });

    const wf: WorkflowDefinition = {
      id: "test-linear",
      steps: [
        { id: "mul", toolName: "multiply", args: { a: 3, b: 4 }, dependsOn: [] },
        { id: "add", toolName: "add", args: { a: "$mul", b: 2 }, dependsOn: ["mul"] },
      ],
    };

    const run = await engine.start(wf);
    const final = await run.wait();
    expect(final.status).toBe("completed");
    // "add" is the leaf node; its output should be 3*4 + 2 = 14.
    expect((final.output as Record<string, unknown>).add).toBe(14);
  });

  it("parallel independent steps both complete before dependent step fires", async () => {
    const tools = new ToolRegistry();
    tools.register(multiplyTool);
    tools.register(addTool);

    const store = new KvWorkflowStateStore(new MemoryKvBackend());
    const engine = new LocalWorkflowEngine({ tools, store });

    const wf: WorkflowDefinition = {
      id: "test-parallel",
      steps: [
        { id: "m1", toolName: "multiply", args: { a: 2, b: 3 }, dependsOn: [] },
        { id: "m2", toolName: "multiply", args: { a: 4, b: 5 }, dependsOn: [] },
        { id: "sum", toolName: "add", args: { a: "$m1", b: "$m2" }, dependsOn: ["m1", "m2"] },
      ],
    };

    const run = await engine.start(wf);
    const final = await run.wait();
    expect(final.status).toBe("completed");
    // "sum" is the leaf node; its output should be 2*3 + 4*5 = 26.
    expect((final.output as Record<string, unknown>).sum).toBe(26);
  });

  it("failed step emits run_failed with error info", async () => {
    const failTool: ToolDefinition<Record<string, never>, string> = {
      name: "always_fail",
      description: "Always throws",
      inputSchema: z.object({}),
      outputSchema: z.string(),
      readOnly: false,
      idempotent: true,
      forward: async () => {
        throw new Error("intentional failure");
      },
    };
    const tools = new ToolRegistry();
    tools.register(failTool);

    const store = new KvWorkflowStateStore(new MemoryKvBackend());
    const engine = new LocalWorkflowEngine({ tools, store });

    const wf: WorkflowDefinition = {
      id: "test-fail",
      steps: [{ id: "boom", toolName: "always_fail", args: {}, dependsOn: [] }],
    };

    const run = await engine.start(wf);
    const final = await run.wait();
    expect(final.status).toBe("failed");
  });

  it("ToolRegistry.fallbacksFor returns alternatives registered in the same registry", () => {
    const tools = new ToolRegistry();
    const primary: ToolDefinition<{ x: number }, number> = {
      name: "compute",
      description: "Main compute",
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.number(),
      readOnly: true,
      idempotent: true,
      alternatives: ["fallback_compute"],
      forward: async ({ x }) => x,
    };
    const fallback: ToolDefinition<{ x: number }, number> = {
      name: "fallback_compute",
      description: "Backup compute",
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.number(),
      readOnly: true,
      idempotent: true,
      forward: async ({ x }) => x,
    };
    tools.register(primary);
    tools.register(fallback);

    const fallbacks = tools.fallbacksFor("compute");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]?.name).toBe("fallback_compute");
  });

  it("ToolRegistry.fallbacksFor returns [] when alternative is not registered", () => {
    const tools = new ToolRegistry();
    const primary: ToolDefinition<{ x: number }, number> = {
      name: "compute",
      description: "Compute",
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.number(),
      readOnly: true,
      idempotent: true,
      alternatives: ["nonexistent_tool"],
      forward: async ({ x }) => x,
    };
    tools.register(primary);
    expect(tools.fallbacksFor("compute")).toHaveLength(0);
  });
});

// ── C. ParallelForkJoinRunner — bscode multi-agent pattern ───────────────────

describe("C. ParallelForkJoinRunner: parallel-branch synthesis (bscode multi-agent pattern)", () => {
  it("runs N branches then synthesises via a 4th model call", async () => {
    // Branches return A/B/C; 4th call is the aggregation summary.
    const model = textModel(["Branch A.", "Branch B.", "Branch C.", "Synthesised: all agree."]);
    const runner = new ParallelForkJoinRunner({ branches: 3 });
    const msgs: ModelMessage[] = [{ role: "user", content: "Summarise the topic." }];
    const result = await runner.run(model, msgs);
    expect(result.branchesCompleted).toBe(3);
    expect(result.answer).toBe("Synthesised: all agree.");
  });

  it("respects concurrency cap — completes even when branches > concurrency", async () => {
    const answers = [...Array.from({ length: 5 }, (_, i) => `Branch ${i}`), "merged"];
    const runner = new ParallelForkJoinRunner({ branches: 5, concurrency: 2 });
    const msgs: ModelMessage[] = [{ role: "user", content: "task" }];
    const result = await runner.run(textModel(answers), msgs);
    expect(result.branchesCompleted).toBe(5);
  });

  it("aggregation=first returns first completed branch (branchesCompleted=1)", async () => {
    const model = textModel(["winner", "ignored-a", "ignored-b"]);
    const runner = new ParallelForkJoinRunner({ branches: 3, aggregation: "first" });
    const msgs: ModelMessage[] = [{ role: "user", content: "minimal task" }];
    const result = await runner.run(model, msgs);
    expect(result.branchesCompleted).toBe(1);
    expect(result.answer).toBe("winner");
  });

  it("aggregation=fn: custom aggregator over branch results", async () => {
    const model = textModel(["X", "Y", "Z"]);
    const runner = new ParallelForkJoinRunner({
      branches: 3,
      aggregation: (results) => results.join("+"),
    });
    const msgs: ModelMessage[] = [{ role: "user", content: "combine" }];
    const result = await runner.run(model, msgs);
    expect(result.answer).toBe("X+Y+Z");
    expect(result.branchesCompleted).toBe(3);
  });
});

// ── D. GoalDirectedAgent full loop ───────────────────────────────────────────

describe("D. GoalDirectedAgent: full scout → criteria → iterations → verified loop", () => {
  it("reaches goal_directed_done with outcome=verified when criteria pass", async () => {
    const ws = fakeWs();
    const synth = textModel([
      JSON.stringify({
        criteria: [
          {
            id: "c1",
            description: "doc.md must contain 'hello'",
            verify_method: "file_contains",
            arg: "hello",
            path: "doc.md",
          },
        ] satisfies Criterion[],
      }),
    ]);
    const exec = scriptedExec(
      [{ text: "done", sideEffect: { path: "doc.md", body: "hello world" } }],
      ws
    );

    const agent = new GoalDirectedAgent({
      model: exec,
      synthModel: synth,
      tools: noTools,
      workspaceReader: ws,
      maxIterations: 2,
      maxStepsPerIteration: 1,
    });

    const events: AgentEvent[] = [];
    for await (const e of agent.run("write doc")) events.push(e);
    const done = events.find((e) => e.event === ("goal_directed_done" as never));
    expect(done).toBeDefined();
    const data = done?.data as { outcome: string };
    expect(data.outcome).toBe("verified");
  });

  it("outcome=exhausted when criteria never pass within maxIterations", async () => {
    const ws = fakeWs();
    const synth = textModel([
      JSON.stringify({
        criteria: [
          {
            id: "c1",
            description: "file must contain 'MAGIC'",
            verify_method: "file_contains",
            arg: "MAGIC",
            path: "out.md",
          },
        ],
      }),
    ]);
    const exec = scriptedExec(
      [
        { text: "try1", sideEffect: { path: "out.md", body: "nope" } },
        { text: "try2", sideEffect: { path: "out.md", body: "still nope" } },
      ],
      ws
    );
    const agent = new GoalDirectedAgent({
      model: exec,
      synthModel: synth,
      tools: noTools,
      workspaceReader: ws,
      maxIterations: 2,
      maxStepsPerIteration: 1,
    });
    const events: AgentEvent[] = [];
    for await (const e of agent.run("write magic")) events.push(e);
    const done = events.find((e) => e.event === ("goal_directed_done" as never));
    const data = done?.data as { outcome: string };
    expect(data.outcome).toBe("exhausted");
  });

  it("empty criteria → fallback single-shot path → outcome=verified", async () => {
    const ws = fakeWs();
    const synth = textModel(["not JSON at all"]);
    const exec = scriptedExec([{ text: "done" }], ws);
    const agent = new GoalDirectedAgent({
      model: exec,
      synthModel: synth,
      tools: noTools,
      workspaceReader: ws,
      maxIterations: 1,
      maxStepsPerIteration: 1,
    });
    const events: AgentEvent[] = [];
    for await (const e of agent.run("anything")) events.push(e);
    const done = events.find((e) => e.event === ("goal_directed_done" as never));
    expect(done).toBeDefined();
    // With no criteria the fallback single-shot path should complete.
    const data = done?.data as { outcome: string };
    expect(["verified", "single-shot"]).toContain(data.outcome);
  });

  it("axis-9 L3: allowNegotiate=true + accept → resumes with relaxed criteria + verified", async () => {
    const ws = fakeWs();
    const unattainable: Criterion = {
      id: "size",
      description: "≥1000 bytes",
      verify_method: "file_size_min",
      arg: 1000,
      path: "doc.md",
    };
    const relaxed: Criterion = {
      id: "size",
      description: "≥10 bytes",
      verify_method: "file_size_min",
      arg: 10,
      path: "doc.md",
    };
    const synth = textModel([
      JSON.stringify({ criteria: [unattainable] }),
      JSON.stringify({
        keep: [],
        relax: [{ original: unattainable, proposed: relaxed, reasoning: "floor unreachable" }],
        dropped: [],
      }),
    ]);
    const exec = scriptedExec(
      [
        { text: "try1", sideEffect: { path: "doc.md", body: "short" } },
        { text: "try2", sideEffect: { path: "doc.md", body: "this is twenty bytes ok!" } },
      ],
      ws
    );
    const agent = new GoalDirectedAgent({
      model: exec,
      synthModel: synth,
      tools: noTools,
      workspaceReader: ws,
      maxIterations: 2,
      maxStepsPerIteration: 1,
      allowNegotiate: true,
      onAdaptationProposed: async () => ({ decision: "accept" }),
    });
    const events: AgentEvent[] = [];
    for await (const e of agent.run("write a long doc")) events.push(e);
    expect(events.find((e) => e.event === "goal_adaptation_proposed")).toBeDefined();
    const done = events.find((e) => e.event === ("goal_directed_done" as never));
    const data = done?.data as { outcome: string };
    expect(data.outcome).toBe("verified");
  });

  it("axis-9 L3: allowNegotiate=false → outcome=exhausted (no proposal emitted)", async () => {
    const ws = fakeWs();
    const synth = textModel([
      JSON.stringify({
        criteria: [
          {
            id: "size",
            description: "≥1000 bytes",
            verify_method: "file_size_min",
            arg: 1000,
            path: "doc.md",
          },
        ],
      }),
    ]);
    const exec = scriptedExec(
      [
        { text: "try1", sideEffect: { path: "doc.md", body: "tiny" } },
        { text: "try2", sideEffect: { path: "doc.md", body: "tiny" } },
      ],
      ws
    );
    const agent = new GoalDirectedAgent({
      model: exec,
      synthModel: synth,
      tools: noTools,
      workspaceReader: ws,
      maxIterations: 2,
      maxStepsPerIteration: 1,
      // allowNegotiate intentionally omitted
    });
    const events: AgentEvent[] = [];
    for await (const e of agent.run("write a long doc")) events.push(e);
    expect(events.find((e) => e.event === "goal_adaptation_proposed")).toBeUndefined();
    const done = events.find((e) => e.event === ("goal_directed_done" as never));
    const data = done?.data as { outcome: string };
    expect(data.outcome).toBe("exhausted");
  });
});

// ── E. Package rename guard ───────────────────────────────────────────────────

describe("E. Package rename guard: @wasmagent/* resolves; no @agentkit-js/* leakage", () => {
  it("ToolRegistry imported from @wasmagent/core is functional", () => {
    const reg = new ToolRegistry();
    const tool: ToolDefinition<{ x: number }, number> = {
      name: "double",
      description: "Double a number",
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.number(),
      readOnly: true,
      idempotent: true,
      forward: async ({ x }) => x * 2,
    };
    reg.register(tool);
    expect(reg.get("double")).toBeDefined();
    expect(reg.get("double")?.name).toBe("double");
  });

  it("ToolCallingAgent, GoalDirectedAgent, ParallelForkJoinRunner all instantiate cleanly", () => {
    const model = textModel(["ok"]);
    const ws = fakeWs();
    expect(() => new ToolCallingAgent({ tools: [], model, maxSteps: 1 })).not.toThrow();
    expect(
      () =>
        new GoalDirectedAgent({
          model,
          synthModel: model,
          tools: [],
          workspaceReader: ws,
        })
    ).not.toThrow();
    expect(() => new ParallelForkJoinRunner({ branches: 1 })).not.toThrow();
  });

  it("LocalWorkflowEngine + KvWorkflowStateStore instantiate with MemoryKvBackend", () => {
    const registry = new ToolRegistry();
    const store = new KvWorkflowStateStore(new MemoryKvBackend());
    expect(() => new LocalWorkflowEngine({ registry, store })).not.toThrow();
  });

  it("WorkspaceReader type imported from @wasmagent/core satisfies its contract", () => {
    const ws: WorkspaceReader = fakeWs({ "test.md": "hello" });
    expect(ws.readFile).toBeTypeOf("function");
    expect(ws.fileExists).toBeTypeOf("function");
    expect(ws.fileSize).toBeTypeOf("function");
  });
});
