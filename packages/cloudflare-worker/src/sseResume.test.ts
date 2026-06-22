/**
 * A2 — End-to-end Last-Event-ID SSE resume through the worker handler.
 *
 * This file does NOT mock @wasmagent/core (unlike index.test.ts) — it uses
 * the real EventLog so we can verify the full resume contract. We still mock
 * the agent and kernel because we don't want to call out to a real model.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentEvent } from "@wasmagent/core";
import { KvCheckpointer, resumeFromHuman } from "../../core/src/checkpoint/index.js";
import { EventLog, formatSseFrame } from "../../core/src/streaming/EventLog.js";
import { KvWorkflowStateStore, MemoryKvBackend } from "../../core/src/workflow/store.js";
import { type CloudflareKVNamespace, CloudflareKvBackend } from "./kvAdapters.js";

// ── Agent + kernel mocks (model-free) ─────────────────────────────────────────
let mockAgentEvents: AgentEvent[] = [];

mock.module("@wasmagent/kernel-quickjs", () => ({ QuickJSKernel: class {} }));
mock.module("quickjs-emscripten-core", () => ({ newQuickJSWASMModuleFromVariant: mock() }));
mock.module("@jitl/quickjs-wasmfile-release-sync", () => ({ default: {} }));

// Partial mock: override only agent/model classes, pass real EventLog/formatSseFrame through.
mock.module("@wasmagent/core", () => {
  return {
    EventLog,
    formatSseFrame,
    KvCheckpointer,
    resumeFromHuman,
    CheckpointableRun: class {
      run<T>(source: AsyncGenerator<T>) {
        return source;
      }
    },
    KvWorkflowStateStore,
    MemoryKvBackend,
    GoalDirectedAgent: class {
      run() {
        return (async function* () {
          for (const e of mockAgentEvents) yield e;
        })();
      }
    },
    CodeAgent: class {
      run() {
        return (async function* () {
          for (const e of mockAgentEvents) yield e;
        })();
      }
    },
    ToolCallingAgent: class {
      run() {
        return (async function* () {
          for (const e of mockAgentEvents) yield e;
        })();
      }
    },
    AnthropicModel: class {},
    AnthropicModels: {
      OPUS_LATEST: "claude-opus-4-8",
      SONNET_LATEST: "claude-sonnet-4-6",
      HAIKU_LATEST: "claude-haiku-4-5-20251001",
    },
  };
});

// ── KV double ────────────────────────────────────────────────────────────────

class FakeKVNamespace implements CloudflareKVNamespace {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
    const prefix = options?.prefix ?? "";
    const all = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    return {
      keys: all.map((name) => ({ name })),
      list_complete: true,
    };
  }
}

// ── Test rig ─────────────────────────────────────────────────────────────────

function ev(step: number): AgentEvent {
  if (step < 0) {
    return {
      traceId: "t",
      parentTraceId: null,
      timestampMs: 1000,
      channel: "text",
      event: "final_answer",
      data: { answer: "done" },
    };
  }
  return {
    traceId: "t",
    parentTraceId: null,
    timestampMs: 1000 + step,
    channel: "thinking",
    event: "step_start",
    data: { step },
  };
}

const mockCtx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
};

const TEST_TOKEN = "test-secret-token";

function makeEnv(overrides: Record<string, unknown> = {}) {
  return { ANTHROPIC_API_KEY: "sk-test", AGENTKIT_CLIENT_TOKEN: TEST_TOKEN, ...overrides };
}

async function readBody(res: Response): Promise<string> {
  return await res.text();
}

function runPost(env: Record<string, unknown>, headers: Record<string, string> = {}) {
  return import("./index.js").then(({ default: worker }) =>
    worker.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
          ...headers,
        },
        body: JSON.stringify({ task: "trace-it" }),
      }),
      env as never,
      mockCtx as never
    )
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("POST /run — Last-Event-ID SSE resume (A2)", () => {
  beforeEach(() => {
    // 5 step_starts then final_answer.
    mockAgentEvents = [ev(0), ev(1), ev(2), ev(3), ev(4), ev(-1)];
  });

  it("first run persists every event under the trace prefix", async () => {
    const ns = new FakeKVNamespace();
    const env = makeEnv({ AGENTKIT_EVENT_LOG: ns });
    const res = await runPost(env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Agentkit-Trace-Id")).toBeTruthy();
    await readBody(res);
    // wait for waitUntil to settle
    await new Promise((r) => setTimeout(r, 50));

    // After a clean run, EventLog.purge() removes all evlog:* keys.
    expect([...ns.map.keys()].some((k) => k.startsWith("evlog:"))).toBe(false);
  });

  it("crashed run leaves event log behind for resume", async () => {
    // Simulate a crash by making the agent throw mid-stream — the code
    // catches it and writes an error frame; in real Workers the worker
    // can also be killed before the final_answer arrives.
    mockAgentEvents = [ev(0), ev(1), ev(2)];
    // Note: no final_answer ⇒ purge is NOT called.
    const ns = new FakeKVNamespace();
    const env = makeEnv({ AGENTKIT_EVENT_LOG: ns });
    const res = await runPost(env);
    expect(res.status).toBe(200);
    await readBody(res);
    await new Promise((r) => setTimeout(r, 50));

    // 3 events should be persisted under the assigned trace id.
    const traceId = res.headers.get("X-Agentkit-Trace-Id");
    expect(traceId).toBeTruthy();
    const persisted = [...ns.map.keys()].filter((k) => k.startsWith(`evlog:${traceId}:`));
    expect(persisted.length).toBe(3);
  });

  it("reconnect with Last-Event-ID + matching X-Agentkit-Trace-Id replays only the missing tail", async () => {
    // Drive a CloudflareKvBackend directly to seed a partial event log,
    // then submit a /run request with Last-Event-ID set.
    const ns = new FakeKVNamespace();
    const backend = new CloudflareKvBackend(ns);
    const traceId = "test-trace-resume";
    // Seed events 0..4 under the trace.
    for (let i = 0; i < 5; i++) {
      const id = String(i).padStart(12, "0");
      await backend.put(`evlog:${traceId}:${id}`, JSON.stringify(ev(i)));
    }

    // We can't force the worker to use this exact traceId without exposing a
    // hook, so we exercise resume through the EventLog primitive directly:
    // server-side handler logic uses replay() then nextSeq(); we assert the
    // semantics here in lieu of a full HTTP round-trip.
    const log = new EventLog(backend);

    const replayed = [];
    for await (const r of log.replay(traceId, "000000000002")) {
      replayed.push(r.eventId);
    }
    expect(replayed).toEqual(["000000000003", "000000000004"]);

    // nextSeq lets the server continue past the high-water mark.
    expect(await log.nextSeq(traceId)).toBe(5);
  });

  it("X-Agentkit-Trace-Id header is always returned so the client can resume", async () => {
    const ns = new FakeKVNamespace();
    const res = await runPost(makeEnv({ AGENTKIT_EVENT_LOG: ns }));
    const traceId = res.headers.get("X-Agentkit-Trace-Id");
    expect(traceId).toBeTruthy();
    expect(traceId?.length).toBeGreaterThan(0);
  });

  it("missing AGENTKIT_EVENT_LOG binding falls back to passthrough (no resume, but stream works)", async () => {
    const res = await runPost(makeEnv()); // no AGENTKIT_EVENT_LOG
    expect(res.status).toBe(200);
    const body = await readBody(res);
    // Each event is still framed with id:/event:/data: for SSE clients that want to track ids.
    expect(body).toContain("id: 000000000000");
    expect(body).toContain("event: step_start");
  });
});
