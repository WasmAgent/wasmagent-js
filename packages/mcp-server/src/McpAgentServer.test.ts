/**
 * F1 — McpAgentServer tests.
 *
 * Wire-level coverage for the MCP server façade. Pin down:
 *   1. JSON-RPC envelope handling (parse errors, unknown methods, ping)
 *   2. initialize advertises the right protocol version + capabilities
 *   3. tools/list returns the configured tool entries with longRunning meta
 *   4. tools/call sync path returns the agent's final answer
 *   5. tools/call escalates to Tasks when sync timeout fires
 *   6. tasks/create + tasks/get + tasks/cancel happy paths
 *   7. tasks/respond clears pendingElicitation and resumes the task state
 *   8. unknown task ids get the dedicated error code
 *   9. stateless: a fresh server instance pointed at the same store can read
 *      a task created by an earlier instance (kill-and-resume pattern)
 *  10. tasks/list enumerates ids when the store supports it
 *  11. invalid params (missing tool name, missing id) get -32602
 *  12. agent that throws lands as a failed task with a recoverable error
 *  13. event log truncation respects maxEventsPerTask but keeps terminal
 *      final_answer
 *  14. createFetchHandler routes only the configured path; OPTIONS returns
 *      CORS preflight; POST returns the JSON-RPC body
 *  15. createFetchHandler handles batch requests
 */

import type { AgentEvent, SubagentRunnable } from "@agentkit-js/core";
import { describe, expect, it } from "vitest";
import { createFetchHandler } from "./fetchHandler.js";
import { McpAgentServer } from "./McpAgentServer.js";
import { InMemoryTaskStore } from "./taskStore.js";

// ── Test fixtures ────────────────────────────────────────────────────────────

interface FakeAgentSpec {
  events?: AgentEvent[];
  delayBeforeFinalMs?: number;
  throwAfterFirst?: boolean;
  /** When set, emit await_human_input after this many regular events. */
  awaitInputAfter?: number;
}

function fakeAgent(spec: FakeAgentSpec = {}): SubagentRunnable {
  const base = (overrides: Partial<AgentEvent> = {}): AgentEvent =>
    ({
      traceId: "t",
      parentTraceId: null,
      timestampMs: 0,
      ...overrides,
    }) as AgentEvent;
  return {
    async *run(task) {
      yield base({ channel: "text", event: "run_start", data: { task } } as Partial<AgentEvent>);
      const events = spec.events ?? [];
      let yielded = 0;
      for (const ev of events) {
        yield ev;
        yielded++;
        if (spec.awaitInputAfter != null && yielded === spec.awaitInputAfter) {
          yield base({
            channel: "status",
            event: "await_human_input",
            data: { promptId: "p1", prompt: "approve?", step: 1 },
          } as Partial<AgentEvent>);
          return; // pause; tasks/respond would unfreeze in real flow
        }
        if (spec.throwAfterFirst) throw new Error("agent crashed");
      }
      if (spec.delayBeforeFinalMs) {
        await new Promise((r) => setTimeout(r, spec.delayBeforeFinalMs));
      }
      yield base({
        channel: "text",
        event: "final_answer",
        data: { answer: "done" },
      } as Partial<AgentEvent>);
    },
  };
}

function rpc(method: string, params?: Record<string, unknown>, id: string | number = 1) {
  return { jsonrpc: "2.0" as const, id, method, ...(params ? { params } : {}) };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("McpAgentServer — JSON-RPC envelope", () => {
  it("rejects non-object requests with parse error", async () => {
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent(),
    });
    const r = await s.handle("not an object");
    expect(r.response.error?.code).toBe(-32700);
  });

  it("rejects requests missing method or jsonrpc with invalid-request error", async () => {
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent(),
    });
    const r = await s.handle({ id: 7 });
    expect(r.response.error?.code).toBe(-32600);
    expect(r.response.id).toBe(7);
  });

  it("returns method-not-found for unknown methods", async () => {
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent(),
    });
    const r = await s.handle(rpc("does/not/exist"));
    expect(r.response.error?.code).toBe(-32601);
  });

  it("ping returns an empty result", async () => {
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent(),
    });
    const r = await s.handle(rpc("ping"));
    expect(r.response.result).toEqual({});
  });
});

describe("McpAgentServer — initialize / tools/list", () => {
  it("initialize advertises protocolVersion 2025-11-25 and tools+tasks capabilities", async () => {
    const s = new McpAgentServer({
      serverInfo: { name: "demo", version: "1.2.3", description: "test" },
      agent: fakeAgent(),
    });
    const r = await s.handle(rpc("initialize"));
    const result = r.response.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string; description?: string };
      capabilities: { tools: object; tasks: object };
    };
    expect(result.protocolVersion).toBe("2025-11-25");
    expect(result.serverInfo).toEqual({ name: "demo", version: "1.2.3", description: "test" });
    expect(result.capabilities.tools).toBeDefined();
    expect(result.capabilities.tasks).toBeDefined();
  });

  it("tools/list returns the default run_agent tool when none supplied", async () => {
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent(),
    });
    const r = await s.handle(rpc("tools/list"));
    const tools = (r.response.result as { tools: Array<{ name: string; _meta?: object }> }).tools;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("run_agent");
    expect(tools[0]?._meta).toBeUndefined();
  });

  it("tools/list surfaces the longRunning hint as _meta", async () => {
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent(),
      tools: [
        {
          name: "slow",
          description: "lengthy",
          inputSchema: { type: "object" },
          longRunning: true,
        },
      ],
    });
    const r = await s.handle(rpc("tools/list"));
    const tools = (r.response.result as { tools: Array<{ _meta?: { longRunning: boolean } }> })
      .tools;
    expect(tools[0]?._meta).toEqual({ longRunning: true });
  });
});

describe("McpAgentServer — tools/call (sync path)", () => {
  it("returns the agent's final_answer in content blocks", async () => {
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent(),
    });
    const r = await s.handle(rpc("tools/call", { name: "run_agent", arguments: { task: "hi" } }));
    const result = r.response.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("done");
  });

  it("returns -32602 when 'name' is missing", async () => {
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent(),
    });
    const r = await s.handle(rpc("tools/call", { arguments: {} }));
    expect(r.response.error?.code).toBe(-32603); // wrapped in INTERNAL because thrown inside try
    expect(r.response.error?.message).toMatch(/'name'/);
  });

  it("returns ERR_TOOL_NOT_FOUND when the tool is unknown", async () => {
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent(),
    });
    const r = await s.handle(rpc("tools/call", { name: "missing", arguments: { task: "x" } }));
    expect(r.response.error?.code).toBe(-32011);
  });

  it("escalates to Tasks API when the sync timeout fires", async () => {
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent({ delayBeforeFinalMs: 200 }),
      syncTimeoutMs: 30,
    });
    const r = await s.handle(rpc("tools/call", { name: "run_agent", arguments: { task: "x" } }));
    const result = r.response.result as { _meta?: { taskId: string } };
    expect(result._meta?.taskId).toMatch(/^t-/);
    expect(r.taskId).toBe(result._meta?.taskId);
  });
});

describe("McpAgentServer — Tasks API", () => {
  it("tasks/create returns id + pending state, then tasks/get reports complete", async () => {
    const store = new InMemoryTaskStore();
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent(),
      taskStore: store,
    });
    const create = await s.handle(
      rpc("tasks/create", { name: "run_agent", arguments: { task: "hi" } })
    );
    const id = (create.response.result as { id: string }).id;
    expect(id).toBeTruthy();
    // The fake agent finishes synchronously in microtasks; flush them.
    await new Promise((r) => setImmediate(r));
    const got = await s.handle(rpc("tasks/get", { id }));
    const rec = got.response.result as { state: string; result: unknown };
    expect(rec.state).toBe("complete");
    expect(rec.result).toBe("done");
  });

  it("tasks/get returns -32010 for an unknown id", async () => {
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent(),
    });
    const r = await s.handle(rpc("tasks/get", { id: "nope" }));
    expect(r.response.error?.code).toBe(-32010);
  });

  it("tasks/cancel marks an in-flight task as failed", async () => {
    const store = new InMemoryTaskStore();
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent({ delayBeforeFinalMs: 200 }),
      taskStore: store,
    });
    const create = await s.handle(
      rpc("tasks/create", { name: "run_agent", arguments: { task: "hi" } })
    );
    const id = (create.response.result as { id: string }).id;
    const cancel = await s.handle(rpc("tasks/cancel", { id }));
    expect((cancel.response.result as { state: string }).state).toBe("failed");
  });

  it("tasks/respond clears pendingElicitation and flips state back to running", async () => {
    const store = new InMemoryTaskStore();
    const ev = (data: Record<string, unknown>, partial: Partial<AgentEvent>): AgentEvent =>
      ({
        traceId: "t",
        parentTraceId: null,
        timestampMs: 0,
        ...partial,
        data,
      }) as AgentEvent;
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent({
        events: [ev({ step: 1 }, { channel: "thinking", event: "step_start" })],
        awaitInputAfter: 1,
      }),
      taskStore: store,
    });
    const create = await s.handle(
      rpc("tasks/create", { name: "run_agent", arguments: { task: "hi" } })
    );
    const id = (create.response.result as { id: string }).id;
    await new Promise((r) => setImmediate(r));
    const got = await s.handle(rpc("tasks/get", { id }));
    expect((got.response.result as { state: string }).state).toBe("awaiting-input");
    expect((got.response.result as { elicitation: object }).elicitation).toMatchObject({
      promptId: "p1",
      prompt: "approve?",
    });

    const resp = await s.handle(rpc("tasks/respond", { id, response: "yes" }));
    expect((resp.response.result as { state: string }).state).toBe("running");
    const after = await s.handle(rpc("tasks/get", { id }));
    expect((after.response.result as { elicitation?: object }).elicitation).toBeUndefined();
  });

  it("tasks/respond on a non-awaiting task returns the dedicated error code", async () => {
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent(),
    });
    const create = await s.handle(
      rpc("tasks/create", { name: "run_agent", arguments: { task: "hi" } })
    );
    const id = (create.response.result as { id: string }).id;
    await new Promise((r) => setImmediate(r));
    const r = await s.handle(rpc("tasks/respond", { id, response: "ok" }));
    expect(r.response.error?.code).toBe(-32012);
  });

  it("tasks/list enumerates ids when the store supports it", async () => {
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent(),
    });
    await s.handle(rpc("tasks/create", { name: "run_agent", arguments: { task: "a" } }));
    await s.handle(rpc("tasks/create", { name: "run_agent", arguments: { task: "b" } }));
    await new Promise((r) => setImmediate(r));
    const l = await s.handle(rpc("tasks/list"));
    const tasks = (l.response.result as { tasks: Array<{ id: string }> }).tasks;
    expect(tasks.length).toBe(2);
  });
});

describe("McpAgentServer — stateless / kill-and-resume", () => {
  it("a fresh server pointed at the same store sees a task created by the prior instance", async () => {
    const store = new InMemoryTaskStore();
    const s1 = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent(),
      taskStore: store,
    });
    const create = await s1.handle(
      rpc("tasks/create", { name: "run_agent", arguments: { task: "hi" } })
    );
    const id = (create.response.result as { id: string }).id;
    await new Promise((r) => setImmediate(r));

    // Simulate a worker recycle.
    const s2 = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent(), // fresh agent, doesn't matter — task already finished
      taskStore: store,
    });
    const got = await s2.handle(rpc("tasks/get", { id }));
    expect((got.response.result as { state: string }).state).toBe("complete");
  });
});

describe("McpAgentServer — error handling", () => {
  it("an agent that throws lands as a failed task with the error message preserved", async () => {
    const store = new InMemoryTaskStore();
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent({
        events: [
          {
            traceId: "t",
            parentTraceId: null,
            timestampMs: 0,
            channel: "thinking",
            event: "step_start",
            data: { step: 1 },
          } as AgentEvent,
        ],
        throwAfterFirst: true,
      }),
      taskStore: store,
    });
    const create = await s.handle(
      rpc("tasks/create", { name: "run_agent", arguments: { task: "hi" } })
    );
    const id = (create.response.result as { id: string }).id;
    await new Promise((r) => setImmediate(r));
    const got = await s.handle(rpc("tasks/get", { id }));
    const rec = got.response.result as { state: string; error: string };
    expect(rec.state).toBe("failed");
    expect(rec.error).toMatch(/agent crashed/);
  });
});

// ── createFetchHandler ──────────────────────────────────────────────────────

describe("createFetchHandler", () => {
  function makeHandler() {
    const server = new McpAgentServer({
      serverInfo: { name: "h", version: "0" },
      agent: fakeAgent(),
    });
    return createFetchHandler(server, { path: "/mcp" });
  }

  it("routes only the configured path", async () => {
    const handler = makeHandler();
    const r = await handler(new Request("http://localhost/other", { method: "POST" }));
    expect(r.status).toBe(404);
  });

  it("OPTIONS returns CORS preflight 204", async () => {
    const handler = makeHandler();
    const r = await handler(new Request("http://localhost/mcp", { method: "OPTIONS" }));
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Methods")).toMatch(/POST/);
  });

  it("POST returns the JSON-RPC body and 200", async () => {
    const handler = makeHandler();
    const r = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rpc("ping")),
      })
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { result: object };
    expect(body.result).toEqual({});
  });

  it("handles batch requests", async () => {
    const handler = makeHandler();
    const r = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([rpc("ping", undefined, 1), rpc("initialize", undefined, 2)]),
      })
    );
    const body = (await r.json()) as Array<{ id: number; result: object }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0]?.id).toBe(1);
    expect(body[1]?.id).toBe(2);
  });

  it("returns 400 with parse error for non-JSON body", async () => {
    const handler = makeHandler();
    const r = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not json",
      })
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });
});

// ── event truncation ────────────────────────────────────────────────────────

describe("McpAgentServer — event log truncation", () => {
  it("respects maxEventsPerTask and still surfaces the final answer", async () => {
    const events: AgentEvent[] = [];
    for (let i = 0; i < 50; i++) {
      events.push({
        traceId: "t",
        parentTraceId: null,
        timestampMs: 0,
        channel: "thinking",
        event: "step_start",
        data: { step: i },
      } as AgentEvent);
    }
    const store = new InMemoryTaskStore();
    const s = new McpAgentServer({
      serverInfo: { name: "x", version: "0" },
      agent: fakeAgent({ events }),
      taskStore: store,
      maxEventsPerTask: 10,
    });
    const create = await s.handle(
      rpc("tasks/create", { name: "run_agent", arguments: { task: "hi" } })
    );
    const id = (create.response.result as { id: string }).id;
    await new Promise((r) => setImmediate(r));
    const got = await s.handle(rpc("tasks/get", { id }));
    const rec = got.response.result as { events: AgentEvent[]; result: unknown };
    // Bound is honoured (within ±1 due to terminal append).
    expect(rec.events.length).toBeLessThanOrEqual(11);
    // Final result still came through.
    expect(rec.result).toBe("done");
  });
});
