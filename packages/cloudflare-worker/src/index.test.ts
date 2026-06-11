/**
 * Tests for the Cloudflare Worker HTTP handler.
 *
 * Strategy: mock @agentkit-js/core and @agentkit-js/kernel-quickjs so tests run
 * in Node.js without real API calls or WASM loading. Call the exported default
 * handler directly with synthetic Request / Env / ExecutionContext values.
 */

import type { AgentEvent } from "@agentkit-js/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@agentkit-js/core", () => {
  return {
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
    // A2 — EventLog + formatSseFrame: tests run without an event log binding,
    // so the EventLog constructor is only ever invoked when the integration
    // wires it up; tests pass the format helper through unchanged.
    EventLog: class {
      // biome-ignore lint/suspicious/noExplicitAny: matches the real shape
      constructor(_kv: any) {}
      async *replay(): AsyncGenerator<unknown> {
        // no persisted events in mocked tests
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
      // biome-ignore lint/suspicious/noExplicitAny: matches real shape
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
    resumeFromHuman: async (
      // biome-ignore lint/suspicious/noExplicitAny: matches real shape
      cp: any,
      traceId: string,
      promptId: string,
      response: string
    ) => {
      const snap = await cp.load(traceId);
      if (!snap || !snap.pendingHumanInput) return false;
      if (snap.pendingHumanInput.promptId !== promptId) return false;
      await cp.respond(traceId, promptId, response);
      return true;
    },
    CheckpointableRun: class {
      // biome-ignore lint/suspicious/noExplicitAny: matches real shape
      constructor(_opts: any, _asm: any) {}
      run<T>(source: AsyncGenerator<T>) {
        return source;
      }
    },
  };
});

vi.mock("@agentkit-js/kernel-quickjs", () => ({
  QuickJSKernel: class {},
}));

vi.mock("quickjs-emscripten-core", () => ({
  newQuickJSWASMModuleFromVariant: vi.fn(),
}));

vi.mock("@jitl/quickjs-wasmfile-release-sync", () => ({
  default: {},
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEnv(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ANTHROPIC_API_KEY: "sk-test",
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
        headers: { "Content-Type": "application/json", ...headers },
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
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe("ok");
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
        headers: { "Content-Type": "text/plain" },
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
    const res = await runPost({ task: "hi" }, makeEnv({ AGENTKIT_CLIENT_TOKEN: "secret" }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Unauthorized");
  });

  it("Bearer token wrong → 401", async () => {
    const res = await runPost({ task: "hi" }, makeEnv({ AGENTKIT_CLIENT_TOKEN: "secret" }), {
      Authorization: "Bearer wrong",
    });
    expect(res.status).toBe(401);
  });

  it("Bearer token correct → 200 SSE stream", async () => {
    const res = await runPost({ task: "hi" }, makeEnv({ AGENTKIT_CLIENT_TOKEN: "secret" }), {
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
  it("AGENTKIT_ALLOWED_ORIGIN matches → origin echoed back", async () => {
    const { default: worker } = await import("./index.js");
    const res = await worker.fetch(
      new Request("http://localhost/health", {
        headers: { Origin: "https://app.example.com" },
      }),
      makeEnv({ AGENTKIT_ALLOWED_ORIGIN: "https://app.example.com" }) as never,
      mockCtx as never
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
  });

  it("AGENTKIT_ALLOWED_ORIGIN mismatches → null", async () => {
    const { default: worker } = await import("./index.js");
    const res = await worker.fetch(
      new Request("http://localhost/health", {
        headers: { Origin: "https://evil.com" },
      }),
      makeEnv({ AGENTKIT_ALLOWED_ORIGIN: "https://app.example.com" }) as never,
      mockCtx as never
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("null");
  });

  it("no AGENTKIT_ALLOWED_ORIGIN → wildcard", async () => {
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
      get: vi.fn().mockResolvedValue(JSON.stringify(cachedEvents)),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const res = await runPost({ task: "cached task" }, makeEnv({ AGENTKIT_SESSIONS: mockKV }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Agentkit-Cache")).toBe("HIT");
    const lines = await readSSELines(res);
    expect(lines.some((l) => l.includes("final_answer"))).toBe(true);
  });

  it("KV cache MISS → runs agent and writes to KV on success", async () => {
    const putMock = vi.fn().mockResolvedValue(undefined);
    const mockKV = {
      get: vi.fn().mockResolvedValue(null),
      put: putMock,
    };
    const res = await runPost({ task: "new task" }, makeEnv({ AGENTKIT_SESSIONS: mockKV }));
    expect(res.status).toBe(200);
    const lines = await readSSELines(res);
    expect(lines.at(-1)).toBe("data: [DONE]");
    // Wait for waitUntil async work to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(putMock).toHaveBeenCalledOnce();
  });

  it("corrupted KV cache → 500 error", async () => {
    const mockKV = {
      get: vi.fn().mockResolvedValue("not valid json {{{"),
      put: vi.fn(),
    };
    const res = await runPost({ task: "cached" }, makeEnv({ AGENTKIT_SESSIONS: mockKV }));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("corrupted");
  });
});

// ── A3: POST /resume ─────────────────────────────────────────────────────────

describe("POST /resume — HITL persisted resume (A3)", () => {
  /** Build an in-memory KV namespace that satisfies the worker's KV usage. */
  function fakeCheckpointKv() {
    const map = new Map<string, string>();
    return {
      map,
      get: vi.fn(async (k: string) => map.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => {
        map.set(k, v);
      }),
      delete: vi.fn(async (k: string) => {
        map.delete(k);
      }),
      list: vi.fn(async (opts: { prefix?: string }) => ({
        keys: [...map.keys()]
          .filter((k) => k.startsWith(opts?.prefix ?? ""))
          .map((name) => ({ name })),
        list_complete: true,
      })),
    };
  }

  async function postResume(body: unknown, env: Record<string, unknown>) {
    return import("./index.js").then(({ default: worker }) =>
      worker.fetch(
        new Request("http://localhost/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        env as never,
        mockCtx as never
      )
    );
  }

  it("503 when AGENTKIT_CHECKPOINTS is not bound", async () => {
    const res = await postResume({ traceId: "t", promptId: "p", response: "r" }, makeEnv());
    expect(res.status).toBe(503);
  });

  it("400 when body is missing required fields", async () => {
    const kv = fakeCheckpointKv();
    const res = await postResume({ traceId: "t" }, makeEnv({ AGENTKIT_CHECKPOINTS: kv }));
    expect(res.status).toBe(400);
  });

  it("404 when no paused snapshot exists", async () => {
    const kv = fakeCheckpointKv();
    const res = await postResume(
      { traceId: "missing", promptId: "p", response: "r" },
      makeEnv({ AGENTKIT_CHECKPOINTS: kv })
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
      makeEnv({ AGENTKIT_CHECKPOINTS: kv })
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
      makeEnv({ AGENTKIT_CHECKPOINTS: kv })
    );
    expect(res.status).toBe(404);
  });

  it("requires Bearer auth when AGENTKIT_CLIENT_TOKEN is set", async () => {
    const kv = fakeCheckpointKv();
    const res = await postResume(
      { traceId: "t", promptId: "p", response: "r" },
      makeEnv({ AGENTKIT_CHECKPOINTS: kv, AGENTKIT_CLIENT_TOKEN: "secret" })
    );
    expect(res.status).toBe(401);
  });
});
