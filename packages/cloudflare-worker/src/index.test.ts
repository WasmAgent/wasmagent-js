/**
 * Tests for the Cloudflare Worker HTTP handler.
 *
 * Strategy: mock @agentkit-js/core and @agentkit-js/kernel-quickjs so tests run
 * in Node.js without real API calls or WASM loading. Call the exported default
 * handler directly with synthetic Request / Env / ExecutionContext values.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest";
import type { AgentEvent } from "@agentkit-js/core";

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
    AnthropicModel: class {
      constructor(_modelId: string, _apiKey: string) {}
    },
  };
});

vi.mock("@agentkit-js/kernel-quickjs", () => ({
  QuickJSKernel: class {
    constructor(_opts?: unknown) {}
  },
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

const mockCtx = { waitUntil: (p: Promise<unknown>) => { p.catch(() => {}); } };

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
    const json = await res.json() as { status: string };
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
    const json = await res.json() as { error: string };
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
    const json = await res.json() as { error: string };
    expect(json.error).toContain("Invalid JSON");
  });

  it("missing task field → 400", async () => {
    const res = await runPost({ agentType: "code" });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toContain("task");
  });

  it("task exceeding 10KB → 400", async () => {
    const bigTask = "x".repeat(11_000);
    const res = await runPost({ task: bigTask });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toContain("task must be under");
  });

  it("invalid agentType → 400", async () => {
    const res = await runPost({ task: "hi", agentType: "bad-type" });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
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
    const json = await res.json() as { error: string };
    expect(json.error).toContain("Unauthorized");
  });

  it("Bearer token wrong → 401", async () => {
    const res = await runPost(
      { task: "hi" },
      makeEnv({ AGENTKIT_CLIENT_TOKEN: "secret" }),
      { Authorization: "Bearer wrong" }
    );
    expect(res.status).toBe(401);
  });

  it("Bearer token correct → 200 SSE stream", async () => {
    const res = await runPost(
      { task: "hi" },
      makeEnv({ AGENTKIT_CLIENT_TOKEN: "secret" }),
      { Authorization: "Bearer secret" }
    );
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
    mockAgentEvents = [{
      traceId: "t1", parentTraceId: null, channel: "text", event: "error",
      data: { error: "something went wrong" }, timestampMs: 0,
    }];
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
    const res = await runPost(
      { task: "cached task" },
      makeEnv({ AGENTKIT_SESSIONS: mockKV })
    );
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
    const res = await runPost(
      { task: "new task" },
      makeEnv({ AGENTKIT_SESSIONS: mockKV })
    );
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
    const res = await runPost(
      { task: "cached" },
      makeEnv({ AGENTKIT_SESSIONS: mockKV })
    );
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toContain("corrupted");
  });
});
