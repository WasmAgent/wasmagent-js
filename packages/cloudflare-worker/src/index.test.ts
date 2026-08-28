/**
 * Tests for the Cloudflare Worker HTTP handler.
 *
 * Strategy: mock @wasmagent/core and @wasmagent/kernel-quickjs so tests run
 * in Node.js without real API calls or WASM loading. Call the exported default
 * handler directly with synthetic Request / Env / ExecutionContext values.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentEvent } from "@wasmagent/core";
import { KvWorkflowStateStore, MemoryKvBackend } from "../../core/src/workflow/store.js";

// ── Mocks ──────────────────────────────────────────────────────────────────────

// Default mock agent emits one final_answer event.
const mockFinalAnswerEvent: AgentEvent = {
  traceId: "t1",
  parentTraceId: null,
  channel: "text",
  event: "final_answer",
  data: { answer: "42" },
  timestampMs: 0,
};

let mockAgentEvents: AgentEvent[] = [mockFinalAnswerEvent];

mock.module("@wasmagent/core", () => {
  return {
    // /health surfaces the live HealthMetrics snapshot; the mock must expose
    // the same singleton shape the worker imports.
    HealthMetrics: {
      getInstance() {
        return {
          getSnapshot: () => ({
            latency: { count: 0, totalMs: 0, avgMs: 0 },
            failures: 0,
            timeouts: 0,
            policyDenials: 0,
            resourceTokensUsed: 0,
          }),
        };
      },
    },
    CodeAgent: class {
      run(_task: string) {
        return (async function* () {
          for (const e of mockAgentEvents) yield e;
        })();
      }
    },
    ToolCallingAgent: class {
      run(_task: string) {
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
    // A2 — EventLog + formatSseFrame: the mock implements replay() against
    // the real backend key format (`evlog:<traceId>:<paddedId>`) so resume
    // tests can seed a KV store and exercise the HTTP path end-to-end.
    EventLog: class {
      #backend: {
        get(key: string): Promise<string | null>;
        put(key: string, value: string): Promise<void>;
        delete(key: string): Promise<void>;
        list(prefix: string): Promise<string[]>;
      };
      constructor(backendInstance: {
        get(key: string): Promise<string | null>;
        put(key: string, value: string): Promise<void>;
        delete(key: string): Promise<void>;
        list(prefix: string): Promise<string[]>;
      }) {
        this.#backend = backendInstance;
      }
      async *replay(
        traceId: string,
        afterId?: string | null
      ): AsyncGenerator<{ eventId: string; event: unknown }> {
        const prefix = `evlog:${traceId}:`;
        const keys = (await this.#backend.list(prefix)).sort();
        const cutoff = afterId && /^\d+$/.test(afterId) ? afterId.padStart(12, "0") : null;
        for (const key of keys) {
          const eventId = key.slice(prefix.length);
          if (cutoff && eventId <= cutoff) continue;
          const raw = await this.#backend.get(key);
          if (!raw) continue;
          yield { eventId, event: JSON.parse(raw) as unknown };
        }
      }
      async *tap<T>(source: AsyncGenerator<T>): AsyncGenerator<{ eventId: string; event: T }> {
        let i = 0;
        for await (const ev of source) {
          yield { eventId: String(i++).padStart(12, "0"), event: ev };
        }
      }
      async nextSeq() {
        return 0;
      }
      async purge() {
        // no-op in tests
      }
    },
    formatSseFrame: (logged: { eventId: string; event: { event: string } }) =>
      `id: ${logged.eventId}\nevent: ${logged.event.event}\ndata: ${JSON.stringify(logged.event)}\n\n`,
    // A3 — KvCheckpointer + resumeFromHuman pass through to a tiny in-test
    // implementation so /resume tests can hit them without spinning up the
    // real core module.
    KvCheckpointer: class TestKvCheckpointer {
      constructor(public kv: any) {}
      async load(traceId: string) {
        const raw = await this.kv.get(traceId);
        return raw ? JSON.parse(raw) : null;
      }
      async save(traceId: string, snap: unknown) {
        await this.kv.put(traceId, JSON.stringify(snap));
      }
      async delete(traceId: string) {
        await this.kv.delete(traceId);
      }
      async respond(traceId: string, promptId: string, response: string) {
        const snap = await this.load(traceId);
        if (!snap) throw new Error(`no snapshot ${traceId}`);
        if (snap.pendingHumanInput?.promptId !== promptId) {
          throw new Error("promptId mismatch");
        }
        snap.humanResponse = { promptId, response };
        await this.save(traceId, snap);
      }
    },
    resumeFromHuman: async (cp: any, traceId: string, promptId: string, response: string) => {
      const snap = await cp.load(traceId);
      if (!snap?.pendingHumanInput) return false;
      if (snap.pendingHumanInput.promptId !== promptId) return false;
      await cp.respond(traceId, promptId, response);
      return true;
    },
    CheckpointableRun: class {
      run<T>(source: AsyncGenerator<T>) {
        return source;
      }
    },
    KvWorkflowStateStore,
    MemoryKvBackend,
    GoalDirectedAgent: class {
      run(_task: string) {
        return (async function* () {
          for (const e of mockAgentEvents) yield e;
        })();
      }
    },
  };
});

mock.module("@wasmagent/kernel-quickjs", () => ({
  QuickJSKernel: class {},
}));

mock.module("quickjs-emscripten-core", () => ({
  newQuickJSWASMModuleFromVariant: mock(),
}));

mock.module("@jitl/quickjs-wasmfile-release-sync", () => ({
  default: {},
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

const TEST_TOKEN = "test-secret-token";

function makeEnv(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ANTHROPIC_API_KEY: "sk-test",
    WASMAGENT_CLIENT_TOKEN: TEST_TOKEN,
    ...overrides,
  };
}

const mockCtx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
};

async function readSSELines(response: Response): Promise<string[]> {
  const text = await response.text();
  return text.split("\n").filter((l) => l.startsWith("data: "));
}

function runPost(
  body: unknown,
  env: Record<string, unknown> = makeEnv(),
  headers: Record<string, string> = {}
) {
  return import("./index.js").then(({ default: worker }) =>
    worker.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
          ...headers,
        },
        body: JSON.stringify(body),
      }),
      env as never,
      mockCtx as never
    )
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Cloudflare Worker routing", () => {
  beforeEach(() => {
    mockAgentEvents = [mockFinalAnswerEvent];
  });

  it("OPTIONS → 204 CORS preflight", async () => {
    const { default: worker } = await import("./index.js");
    const res = await worker.fetch(
      new Request("http://localhost/run", { method: "OPTIONS" }),
      makeEnv() as never,
      mockCtx as never
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("GET /health → 200 with status ok", async () => {
    const { default: worker } = await import("./index.js");
    const res = await worker.fetch(
      new Request("http://localhost/health"),
      makeEnv() as never,
      mockCtx as never
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status: string;
      metrics?: {
        latency: { count: number };
        failures: number;
        timeouts: number;
        policyDenials: number;
        resourceTokensUsed: number;
      };
    };
    expect(json.status).toBe("ok");
    // /health must expose the operational-health snapshot (#388).
    expect(json.metrics).toBeDefined();
    expect(json.metrics?.latency).toBeDefined();
    expect(typeof json.metrics?.failures).toBe("number");
    expect(typeof json.metrics?.timeouts).toBe("number");
    expect(typeof json.metrics?.policyDenials).toBe("number");
    expect(typeof json.metrics?.resourceTokensUsed).toBe("number");
  });

  it("GET /unknown → 404", async () => {
    const { default: worker } = await import("./index.js");
    const res = await worker.fetch(
      new Request("http://localhost/unknown"),
      makeEnv() as never,
      mockCtx as never
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /run — input validation", () => {
  beforeEach(() => {
    mockAgentEvents = [mockFinalAnswerEvent];
  });

  it("missing ANTHROPIC_API_KEY → 500", async () => {
    const res = await runPost({ task: "test" }, makeEnv({ ANTHROPIC_API_KEY: "" }));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("ANTHROPIC_API_KEY");
  });

  it("non-JSON body → 400", async () => {
    const { default: worker } = await import("./index.js");
    const res = await worker.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "text/plain", Authorization: `Bearer ${TEST_TOKEN}` },
        body: "not json",
      }),
      makeEnv() as never,
      mockCtx as never
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Invalid JSON");
  });

  it("missing task field → 400", async () => {
    const res = await runPost({ agentType: "code" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("task");
  });

  it("task exceeding 10KB → 400", async () => {
    const bigTask = "x".repeat(11_000);
    const res = await runPost({ task: bigTask });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("task must be under");
  });

  it("invalid agentType → 400", async () => {
    const res = await runPost({ task: "hi", agentType: "bad-type" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("agentType");
  });
});

describe("POST /run — authentication", () => {
  beforeEach(() => {
    mockAgentEvents = [mockFinalAnswerEvent];
  });

  it("Bearer token required but missing → 401", async () => {
    const res = await runPost({ task: "hi" }, makeEnv({ WASMAGENT_CLIENT_TOKEN: "secret" }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Unauthorized");
  });

  it("Bearer token wrong → 401", async () => {
    const res = await runPost({ task: "hi" }, makeEnv({ WASMAGENT_CLIENT_TOKEN: "secret" }), {
      Authorization: "Bearer wrong",
    });
    expect(res.status).toBe(401);
  });

  it("Bearer token correct → 200 SSE stream", async () => {
    const res = await runPost({ task: "hi" }, makeEnv({ WASMAGENT_CLIENT_TOKEN: "secret" }), {
      Authorization: "Bearer secret",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });
});

describe("POST /run — SSE streaming", () => {
  beforeEach(() => {
    mockAgentEvents = [mockFinalAnswerEvent];
  });

  it("successful run → SSE stream with events + [DONE]", async () => {
    const res = await runPost({ task: "What is 2+2?" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const lines = await readSSELines(res);
    // At least one data line with the event
    expect(lines.some((l) => l.includes("final_answer"))).toBe(true);
    // Must end with [DONE]
    expect(lines.at(-1)).toBe("data: [DONE]");
  });

  it("tool-calling agentType → returns SSE stream", async () => {
    const res = await runPost({ task: "hi", agentType: "tool-calling" });
    expect(res.status).toBe(200);
    const lines = await readSSELines(res);
    expect(lines.at(-1)).toBe("data: [DONE]");
  });

  it("agent error event is streamed", async () => {
    mockAgentEvents = [
      {
        traceId: "t1",
        parentTraceId: null,
        channel: "text",
        event: "error",
        data: { error: "something went wrong" },
        timestampMs: 0,
      },
    ];
    const res = await runPost({ task: "fail" });
    expect(res.status).toBe(200);
    const lines = await readSSELines(res);
    expect(lines.some((l) => l.includes("error"))).toBe(true);
  });

  it("maxSteps is clamped to MAX_STEPS_CAP", async () => {
    // If maxSteps=1000 were honored, mock agent still completes fine — test that
    // no error occurs and stream completes normally (clamping doesn't reject).
    const res = await runPost({ task: "hi", maxSteps: 1000 });
    expect(res.status).toBe(200);
    const lines = await readSSELines(res);
    expect(lines.at(-1)).toBe("data: [DONE]");
  });
});

describe("POST /run — CORS", () => {
  it("WASMAGENT_ALLOWED_ORIGIN matches → origin echoed back", async () => {
    const { default: worker } = await import("./index.js");
    const res = await worker.fetch(
      new Request("http://localhost/health", {
        headers: { Origin: "https://app.example.com" },
      }),
      makeEnv({ WASMAGENT_ALLOWED_ORIGIN: "https://app.example.com" }) as never,
      mockCtx as never
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
  });

  it("WASMAGENT_ALLOWED_ORIGIN mismatches → null", async () => {
    const { default: worker } = await import("./index.js");
    const res = await worker.fetch(
      new Request("http://localhost/health", {
        headers: { Origin: "https://evil.com" },
      }),
      makeEnv({ WASMAGENT_ALLOWED_ORIGIN: "https://app.example.com" }) as never,
      mockCtx as never
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("null");
  });

  it("no WASMAGENT_ALLOWED_ORIGIN → wildcard", async () => {
    const { default: worker } = await import("./index.js");
    const res = await worker.fetch(
      new Request("http://localhost/health"),
      makeEnv() as never,
      mockCtx as never
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("POST /run — KV session caching", () => {
  it("KV cache HIT → replays cached events with X-Agentkit-Cache: HIT", async () => {
    const cachedEvents: AgentEvent[] = [mockFinalAnswerEvent];
    const mockKV = {
      get: mock().mockResolvedValue(JSON.stringify(cachedEvents)),
      put: mock().mockResolvedValue(undefined),
    };
    const res = await runPost({ task: "cached task" }, makeEnv({ WASMAGENT_SESSIONS: mockKV }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Agentkit-Cache")).toBe("HIT");
    const lines = await readSSELines(res);
    expect(lines.some((l) => l.includes("final_answer"))).toBe(true);
  });

  it("KV cache MISS → runs agent and writes to KV on success", async () => {
    const putMock = mock().mockResolvedValue(undefined);
    const mockKV = {
      get: mock().mockResolvedValue(null),
      put: putMock,
    };
    const res = await runPost({ task: "new task" }, makeEnv({ WASMAGENT_SESSIONS: mockKV }));
    expect(res.status).toBe(200);
    const lines = await readSSELines(res);
    expect(lines.at(-1)).toBe("data: [DONE]");
    // Wait for waitUntil async work to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(putMock).toHaveBeenCalledOnce();
  });

  it("corrupted KV cache → 500 error", async () => {
    const mockKV = {
      get: mock().mockResolvedValue("not valid json {{{"),
      put: mock(),
    };
    const res = await runPost({ task: "cached" }, makeEnv({ WASMAGENT_SESSIONS: mockKV }));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("corrupted");
  });
});

// ── AG-UI resume (RunAgentInput.resume) ─────────────────────────────────────

describe("POST /run — AG-UI resume from WASMAGENT_SESSIONS", () => {
  beforeEach(() => {
    mockAgentEvents = [mockFinalAnswerEvent];
  });

  it("resume:true with threadId → replays KV-cached events (X-Agentkit-Cache: HIT)", async () => {
    const cachedEvents: AgentEvent[] = [mockFinalAnswerEvent];
    const getMock = mock().mockResolvedValue(JSON.stringify(cachedEvents));
    const mockKV = { get: getMock, put: mock().mockResolvedValue(undefined) };

    const res = await runPost(
      { threadId: "thread-abc", resume: true },
      makeEnv({ WASMAGENT_SESSIONS: mockKV })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Agentkit-Cache")).toBe("HIT");
    // KV was queried with the threadId as the session key
    expect(getMock).toHaveBeenCalledWith("thread-abc", "text");
  });

  it("resume:string → uses that string as the session key", async () => {
    const cachedEvents: AgentEvent[] = [mockFinalAnswerEvent];
    const getMock = mock().mockResolvedValue(JSON.stringify(cachedEvents));
    const mockKV = { get: getMock, put: mock().mockResolvedValue(undefined) };

    const res = await runPost(
      { threadId: "thread-abc", resume: "explicit-session-id" },
      makeEnv({ WASMAGENT_SESSIONS: mockKV })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Agentkit-Cache")).toBe("HIT");
    expect(getMock).toHaveBeenCalledWith("explicit-session-id", "text");
  });

  it("resume:true with no KV match → falls through to fresh run (no HIT header)", async () => {
    const getMock = mock().mockResolvedValue(null);
    const mockKV = { get: getMock, put: mock().mockResolvedValue(undefined) };

    const res = await runPost(
      { threadId: "thread-new", resume: true },
      makeEnv({ WASMAGENT_SESSIONS: mockKV })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Agentkit-Cache")).toBeNull();
    const lines = await readSSELines(res);
    expect(lines.at(-1)).toBe("data: [DONE]");
  });

  it("resume:true without WASMAGENT_SESSIONS → runs fresh agent normally", async () => {
    const res = await runPost({ threadId: "thread-xyz", resume: true }, makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Agentkit-Cache")).toBeNull();
    const lines = await readSSELines(res);
    expect(lines.at(-1)).toBe("data: [DONE]");
  });

  it("resume:true without threadId and no WASMAGENT_SESSIONS → fresh run", async () => {
    // resume:true but no threadId — session key is null, skip resume lookup.
    // KV is still queried for the content-hash cache (one call), but not for resume.
    const getMock = mock().mockResolvedValue(null);
    const mockKV = { get: getMock, put: mock().mockResolvedValue(undefined) };
    const res = await runPost({ resume: true }, makeEnv({ WASMAGENT_SESSIONS: mockKV }));
    // Session key is null (no threadId), so no extra resume KV lookup — only the
    // content-hash cache lookup fires (one call).  The run should complete normally.
    await new Promise((r) => setTimeout(r, 50));
    expect(getMock).toHaveBeenCalledTimes(1); // content-hash cache only, not resume
    expect(res.status).toBe(200);
  });
});

// ── A3: POST /resume ─────────────────────────────────────────────────────────
describe("POST /resume — HITL persisted resume (A3)", () => {
  /** Build an in-memory KV namespace that satisfies the worker's KV usage. */
  function fakeCheckpointKv() {
    const map = new Map<string, string>();
    return {
      map,
      get: mock(async (k: string) => map.get(k) ?? null),
      put: mock(async (k: string, v: string) => {
        map.set(k, v);
      }),
      delete: mock(async (k: string) => {
        map.delete(k);
      }),
      list: mock(async (opts: { prefix?: string }) => ({
        keys: [...map.keys()]
          .filter((k) => k.startsWith(opts?.prefix ?? ""))
          .map((name) => ({ name })),
        list_complete: true,
      })),
    };
  }

  async function postResume(
    body: unknown,
    env: Record<string, unknown>,
    headers: Record<string, string> = {}
  ) {
    return import("./index.js").then(({ default: worker }) =>
      worker.fetch(
        new Request("http://localhost/resume", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_TOKEN}`,
            ...headers,
          },
          body: JSON.stringify(body),
        }),
        env as never,
        mockCtx as never
      )
    );
  }

  it("503 when WASMAGENT_CHECKPOINTS is not bound", async () => {
    const res = await postResume({ traceId: "t", promptId: "p", response: "r" }, makeEnv());
    expect(res.status).toBe(503);
  });

  it("400 when body is missing required fields", async () => {
    const kv = fakeCheckpointKv();
    const res = await postResume({ traceId: "t" }, makeEnv({ WASMAGENT_CHECKPOINTS: kv }));
    expect(res.status).toBe(400);
  });

  it("404 when no paused snapshot exists", async () => {
    const kv = fakeCheckpointKv();
    const res = await postResume(
      { traceId: "missing", promptId: "p", response: "r" },
      makeEnv({ WASMAGENT_CHECKPOINTS: kv })
    );
    expect(res.status).toBe(404);
  });

  it("succeeds when a paused snapshot exists and writes humanResponse back", async () => {
    const kv = fakeCheckpointKv();
    // Seed a paused snapshot directly into KV.
    kv.map.set(
      "trace-paused",
      JSON.stringify({
        traceId: "trace-paused",
        task: "task",
        history: [],
        stepIndex: 0,
        savedAtMs: 0,
        pendingHumanInput: { promptId: "p1", prompt: "Approve?" },
      })
    );
    const res = await postResume(
      { traceId: "trace-paused", promptId: "p1", response: "approve" },
      makeEnv({ WASMAGENT_CHECKPOINTS: kv })
    );
    expect(res.status).toBe(200);
    const snapAfter = JSON.parse(kv.map.get("trace-paused") ?? "{}");
    expect(snapAfter.humanResponse).toEqual({ promptId: "p1", response: "approve" });
  });

  it("rejects mismatched promptId", async () => {
    const kv = fakeCheckpointKv();
    kv.map.set(
      "t",
      JSON.stringify({
        traceId: "t",
        task: "t",
        history: [],
        stepIndex: 0,
        savedAtMs: 0,
        pendingHumanInput: { promptId: "expected", prompt: "?" },
      })
    );
    const res = await postResume(
      { traceId: "t", promptId: "wrong", response: "x" },
      makeEnv({ WASMAGENT_CHECKPOINTS: kv })
    );
    expect(res.status).toBe(404);
  });

  it("requires Bearer auth when WASMAGENT_CLIENT_TOKEN is set", async () => {
    const kv = fakeCheckpointKv();
    const res = await postResume(
      { traceId: "t", promptId: "p", response: "r" },
      makeEnv({ WASMAGENT_CHECKPOINTS: kv, WASMAGENT_CLIENT_TOKEN: "secret" })
    );
    expect(res.status).toBe(401);
  });
});

// ── Resume-only mode (review fix) ────────────────────────────────────────────
//
// When the client asks to resume (resumeTraceId / Last-Event-ID) and the
// event log still has content, the worker must REPLAY ONLY — re-executing
// the task double-bills the model call and streams duplicated text.

describe("POST /run — resume-only mode (review fix)", () => {
  it("replays a persisted log for resumeTraceId without re-executing the task", async () => {
    const store = new Map<string, string>();
    const kv = {
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
      async list(opts?: { prefix?: string }) {
        const keys = [...store.keys()]
          .filter((k) => !opts?.prefix || k.startsWith(opts.prefix))
          .map((name) => ({ name }));
        return { keys, list_complete: true, cursor: "" };
      },
    };
    // Seed the event log with one persisted event for trace "tr-abc".
    const persisted = {
      traceId: "tr-abc",
      channel: "text",
      event: "text_delta",
      data: { delta: "persisted chunk" },
      timestampMs: Date.now(),
    };
    await kv.put("evlog:tr-abc:000000000000", JSON.stringify(persisted));

    const res = await runPost(
      { task: "fresh task", resumeTraceId: "tr-abc" },
      makeEnv({ WASMAGENT_EVENT_LOG: kv })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Agentkit-Trace-Id")).toBe("tr-abc");
    const lines = await readSSELines(res);
    const joined = lines.join("\n");
    // Replay contains the persisted event and the [DONE] sentinel…
    expect(joined).toContain("persisted chunk");
    expect(joined).toContain("[DONE]");
    // …and NOT a second execution (the mocked agent answers "42").
    expect(joined).not.toContain("42");
  });

  it("falls through to a live run when the log is empty (KV eventual consistency)", async () => {
    const store = new Map<string, string>();
    const kv = {
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
      async list(opts?: { prefix?: string }) {
        const keys = [...store.keys()]
          .filter((k) => !opts?.prefix || k.startsWith(opts.prefix))
          .map((name) => ({ name }));
        return { keys, list_complete: true, cursor: "" };
      },
    };
    const res = await runPost(
      { task: "fresh task", resumeTraceId: "tr-nothing" },
      makeEnv({ WASMAGENT_EVENT_LOG: kv })
    );
    expect(res.status).toBe(200);
    const lines = await readSSELines(res);
    // Nothing persisted → execute normally and stream the answer.
    expect(lines.join("\n")).toContain("42");
  });
});
