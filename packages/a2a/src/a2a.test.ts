import type { AgentEvent, SubagentRunnable } from "@wasmagent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { A2ARemoteAgent } from "./A2ARemoteAgent.js";
import { createA2AServer } from "./A2AServer.js";

function makeAgent(answer: string): SubagentRunnable {
  return {
    async *run(task: string, parentTraceId?: string | null): AsyncGenerator<AgentEvent> {
      yield {
        traceId: "test-trace",
        parentTraceId: parentTraceId ?? null,
        channel: "text",
        event: "run_start",
        data: { task },
        timestampMs: Date.now(),
      } as AgentEvent;
      yield {
        traceId: "test-trace",
        parentTraceId: parentTraceId ?? null,
        channel: "text",
        event: "final_answer",
        data: { answer },
        timestampMs: Date.now(),
      } as AgentEvent;
    },
  };
}

describe("A2A Agent Card schema", () => {
  it("createA2AServer generates a valid Agent Card", async () => {
    const agent = makeAgent("hello");
    const server = createA2AServer(agent, {
      agentId: "https://example.com/agents/test",
      name: "Test Agent",
      description: "A test agent",
      skills: ["test:skill"],
      port: 13401,
    });

    const card = server.agentCard();
    expect(card.id).toBe("https://example.com/agents/test");
    expect(card.name).toBe("Test Agent");
    expect(card.protocolVersion).toBe("1.0");
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.skills).toContain("test:skill");
    expect(card.taskEndpoint).toContain("/tasks");
  });
});

describe("A2A Server integration", () => {
  let serverUrl: string | null = null;
  let stopFn: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stopFn) {
      await stopFn();
      stopFn = null;
      serverUrl = null;
    }
  });

  it("serves Agent Card at /.well-known/agent-card", async () => {
    const agent = makeAgent("42");
    const server = createA2AServer(agent, {
      agentId: "urn:test:agent",
      name: "Test",
      description: "Test agent",
      port: 13402,
    });
    serverUrl = await server.start();
    stopFn = () => server.stop();

    const resp = await fetch(`${serverUrl}/.well-known/agent-card`);
    expect(resp.ok).toBe(true);
    const card = (await resp.json()) as Record<string, unknown>;
    expect(card.protocolVersion).toBe("1.0");
    expect(card.name).toBe("Test");
  });

  it("accepts POST /tasks and returns completed result", async () => {
    const agent = makeAgent("the answer is 42");
    const server = createA2AServer(agent, {
      agentId: "urn:test:agent2",
      name: "Test2",
      description: "Test agent 2",
      port: 13403,
    });
    serverUrl = await server.start();
    stopFn = () => server.stop();

    const resp = await fetch(`${serverUrl}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "task-001", message: "What is 6 times 7?" }),
    });
    expect(resp.ok).toBe(true);
    const result = (await resp.json()) as Record<string, unknown>;
    expect(result.status).toBe("completed");
    expect(result.result).toBe("the answer is 42");
    expect(result.taskId).toBe("task-001");
  });

  it("returns 404 for unknown paths", async () => {
    const agent = makeAgent("hi");
    const server = createA2AServer(agent, {
      agentId: "urn:test:agent3",
      name: "Test3",
      description: "x",
      port: 13404,
    });
    serverUrl = await server.start();
    stopFn = () => server.stop();

    const resp = await fetch(`${serverUrl}/unknown`);
    expect(resp.status).toBe(404);
  });
});

describe("A2ARemoteAgent.asTool", () => {
  it("creates a valid ToolDefinition", () => {
    const tool = A2ARemoteAgent.asTool({
      taskEndpoint: "https://example.com/tasks",
      name: "remote_agent",
      description: "A remote agent",
    });
    expect(tool.name).toBe("remote_agent");
    expect(tool.readOnly).toBe(false);
    expect(tool.idempotent).toBe(false);
    expect(typeof tool.forward).toBe("function");
  });

  it("forward() calls the remote endpoint and returns result", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ taskId: "t1", status: "completed", result: "remote answer" }),
      text: async () => "",
    });

    // Temporarily replace global fetch.
    const origFetch = global.fetch;
    global.fetch = fetchMock as typeof fetch;

    try {
      const tool = A2ARemoteAgent.asTool({
        taskEndpoint: "https://example.com/tasks",
        name: "remote_agent",
        description: "x",
        timeoutMs: 5000,
      });
      const result = await tool.forward({ task: "do something" }, undefined);
      expect(result).toBe("remote answer");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.com/tasks",
        expect.objectContaining({ method: "POST" })
      );
    } finally {
      global.fetch = origFetch;
    }
  });

  it("forward() throws on remote agent failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ taskId: "t2", status: "failed", error: "boom" }),
      text: async () => "",
    });

    const origFetch = global.fetch;
    global.fetch = fetchMock as typeof fetch;
    try {
      const tool = A2ARemoteAgent.asTool({
        taskEndpoint: "https://example.com/tasks",
        name: "remote_agent",
        description: "x",
      });
      await expect(tool.forward({ task: "fail" }, undefined)).rejects.toThrow("boom");
    } finally {
      global.fetch = origFetch;
    }
  });
});
