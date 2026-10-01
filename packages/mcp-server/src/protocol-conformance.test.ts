/**
 * Protocol conformance pins for the MCP protocol-support matrix
 * (evals/protocol/mcp-protocol-matrix.json).
 *
 * Each test id (PROTO-*) is referenced from a matrix row. These tests pin the
 * behavior AS DOCUMENTED in the matrix at the tested commit — including the
 * documented stance that the server always declares its own protocol version
 * and never negotiates down. Rows marked with a conformance gap
 * (GAP-BATCH-NOTIF) are deliberately NOT pinned here; they flip to pinned
 * tests together with the conformance fix.
 */

import { describe, expect, it } from "bun:test";
import type { AgentEvent, SubagentRunnable } from "@wasmagent/core";
import { createFetchHandler } from "./fetchHandler.js";
import { McpAgentServer } from "./McpAgentServer.js";

function okAgent(): SubagentRunnable {
  return {
    async *run(): AsyncGenerator<AgentEvent> {
      yield {
        traceId: "t",
        parentTraceId: null,
        timestampMs: 0,
        channel: "text",
        event: "final_answer",
        data: { answer: "done" },
      } as AgentEvent;
    },
  };
}

function makeServer(): McpAgentServer {
  return new McpAgentServer({
    serverInfo: { name: "conformance-test", version: "0.0.0" },
    agent: okAgent(),
    tools: [
      {
        name: "echo",
        description: "echo a value",
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
      },
    ],
  });
}

function post(handler: ReturnType<typeof createFetchHandler>, body: unknown, init?: RequestInit) {
  return handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    })
  );
}

// ── PROTO-INIT-01: initialize declaration vs client preference ──────────────

describe("PROTO-INIT: protocol revision declaration", () => {
  it("PROTO-INIT-01: a client requesting 2025-06-18 still receives the server's 2025-11-25 declaration", async () => {
    const server = makeServer();
    const res = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    const body = res.response as { result?: { protocolVersion?: string } };
    expect(body.result?.protocolVersion).toBe("2025-11-25");
  });
});

// ── PROTO-ENV: envelope errors echo the request id ───────────────────────────

describe("PROTO-ENV: malformed JSON-RPC envelope", () => {
  it("PROTO-ENV-01: jsonrpc 1.0 envelope → -32600 with the request id echoed", async () => {
    const server = makeServer();
    const res = await server.handle({ jsonrpc: "1.0", id: 42, method: "tools/list" });
    const body = res.response as { id?: unknown; error?: { code?: number } };
    expect(body.id).toBe(42);
    expect(body.error?.code).toBe(-32600);
  });

  it("PROTO-ENV-02: unknown extension method → -32601", async () => {
    const server = makeServer();
    const res = await server.handle({ jsonrpc: "2.0", id: 7, method: "x-wasmagent/custom" });
    const body = res.response as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32601);
  });
});

// ── PROTO-BATCH: batch framing over HTTP ─────────────────────────────────────

describe("PROTO-BATCH: JSON-RPC batch over HTTP", () => {
  it("PROTO-BATCH-01: batch beyond maxBatchSize → 413 Batch too large", async () => {
    const handler = createFetchHandler(makeServer(), { maxBatchSize: 2 });
    const res = await post(handler, [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", id: 3, method: "ping" },
    ]);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error?: { code?: number; message?: string } };
    expect(body.error?.message).toBe("Batch too large");
  });

  it("PROTO-DUPID-01: duplicate request ids in one batch are each answered independently", async () => {
    const handler = createFetchHandler(makeServer());
    const res = await post(handler, [
      { jsonrpc: "2.0", id: 5, method: "ping" },
      { jsonrpc: "2.0", id: 5, method: "tools/list" },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id?: unknown; result?: unknown }>;
    expect(body).toHaveLength(2);
    expect(body.every((r) => r.id === 5)).toBe(true);
    // ping → empty result; tools/list → tools array.
    const results = body.map((r) => r.result);
    expect(results.some((r) => r && typeof r === "object" && "tools" in (r as object))).toBe(true);
  });
});

// ── PROTO-NOTIF: notification semantics (GAP-BATCH-NOTIF fix) ────────────────

describe("PROTO-NOTIF: JSON-RPC notification semantics", () => {
  it("PROTO-NOTIF-01: a notification inside a batch gets NO response entry", async () => {
    const handler = createFetchHandler(makeServer());
    const res = await post(handler, [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id?: unknown }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe(1);
  });

  it("PROTO-NOTIF-02: an all-notification batch → 204 with no body", async () => {
    const handler = createFetchHandler(makeServer());
    const res = await post(handler, [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } },
    ]);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("PROTO-NOTIF-03: a lone notification over HTTP → 202 Accepted with no body", async () => {
    const handler = createFetchHandler(makeServer());
    const res = await post(handler, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });
});

// ── PROTO-HTTP: HTTP surface edges ───────────────────────────────────────────

describe("PROTO-HTTP: HTTP transport edges", () => {
  it("PROTO-HTTP-01: GET /mcp → 405 Method Not Allowed", async () => {
    const handler = createFetchHandler(makeServer());
    const res = await handler(new Request("http://localhost/mcp", { method: "GET" }));
    expect(res.status).toBe(405);
  });

  it("PROTO-BODY-01: body larger than maxBodyBytes → 413 Request body too large", async () => {
    const handler = createFetchHandler(makeServer(), { maxBodyBytes: 16 });
    const res = await post(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      padding: "x".repeat(64),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe("Request body too large");
  });
});

// ── PROTO-CONC: concurrent requests on one instance ──────────────────────────

describe("PROTO-CONC: concurrency", () => {
  it("PROTO-CONC-01: two concurrent handle() calls are isolated and both complete", async () => {
    const server = makeServer();
    const [a, b] = await Promise.all([
      server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      server.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo", arguments: { value: "hi" } },
      }),
    ]);
    const ra = a.response as { id?: unknown; result?: { tools?: unknown[] } };
    const rb = b.response as { id?: unknown; result?: { content?: unknown[] } };
    expect(ra.id).toBe(1);
    expect(ra.result?.tools).toHaveLength(1);
    expect(rb.id).toBe(2);
    expect(rb.result?.content).toBeDefined();
  });
});
