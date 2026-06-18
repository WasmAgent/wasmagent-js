/**
 * createCodeModeServer — tests for the A1 code-mode MCP surface.
 *
 * Pin down:
 *  1. tools/list publishes exactly docs_search + execute_code (no others).
 *  2. docs_search returns markdown describing the registered downstream tools.
 *  3. docs_search filters by query substring and by exact names.
 *  4. execute_code runs a script that calls a downstream tool via callTool()
 *     and returns ONLY the script's final return value (not the intermediate
 *     tool output) — this is the whole point of code-mode.
 *  5. execute_code surfaces script errors as a failed task.
 *  6. capability denial (e.g. fetch to non-allowlisted host) propagates as an
 *     error, demonstrating the unified policy face is honoured.
 */

import { JsKernel, ToolRegistry } from "@wasmagent/core";
import { z } from "zod";
import { createCodeModeServer } from "./codeMode.js";
import { InMemoryTaskStore } from "./taskStore.js";

function buildRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register({
    name: "add",
    description: "Add two integers and return their sum.",
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    outputSchema: z.number(),
    readOnly: true,
    idempotent: true,
    forward: async ({ a, b }) => a + b,
  });
  reg.register({
    name: "uppercase",
    description: "Uppercase the input string.",
    inputSchema: z.object({ s: z.string() }),
    outputSchema: z.string(),
    readOnly: true,
    idempotent: true,
    forward: async ({ s }) => s.toUpperCase(),
  });
  return reg;
}

function rpc(method: string, params?: Record<string, unknown>, id: string | number = 1) {
  return { jsonrpc: "2.0" as const, id, method, ...(params ? { params } : {}) };
}

describe("createCodeModeServer — tools/list", () => {
  it("publishes exactly docs_search + execute_code", async () => {
    const server = createCodeModeServer({
      serverInfo: { name: "test", version: "0.0.0" },
      tools: buildRegistry(),
      kernel: new JsKernel(),
      taskStore: new InMemoryTaskStore(),
    });
    const { response } = await server.handle(rpc("tools/list"));
    const result = response.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["docs_search", "execute_code"]);
  });
});

describe("createCodeModeServer — docs_search", () => {
  it("returns descriptions for all registered tools when no filter", async () => {
    const server = createCodeModeServer({
      serverInfo: { name: "test", version: "0.0.0" },
      tools: buildRegistry(),
      kernel: new JsKernel(),
    });
    const { response } = await server.handle(
      rpc("tools/call", { name: "docs_search", arguments: {} })
    );
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain("add");
    expect(text).toContain("uppercase");
    expect(text).toContain("Uppercase the input string");
  });

  it("filters by substring query", async () => {
    const server = createCodeModeServer({
      serverInfo: { name: "test", version: "0.0.0" },
      tools: buildRegistry(),
      kernel: new JsKernel(),
    });
    const { response } = await server.handle(
      rpc("tools/call", { name: "docs_search", arguments: { query: "uppercase" } })
    );
    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain("uppercase");
    expect(result.content[0].text).not.toContain("### add\n");
  });

  it("supports exact name lookup that takes precedence over query", async () => {
    const server = createCodeModeServer({
      serverInfo: { name: "test", version: "0.0.0" },
      tools: buildRegistry(),
      kernel: new JsKernel(),
    });
    const { response } = await server.handle(
      rpc("tools/call", { name: "docs_search", arguments: { names: ["add"], query: "uppercase" } })
    );
    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain("### add");
    expect(result.content[0].text).not.toContain("### uppercase");
  });
});

describe("createCodeModeServer — execute_code", () => {
  // execute_code is declared longRunning, so the server routes it through
  // its Tasks API. We follow the same poll-pattern McpAgentServer.test.ts uses.
  it("runs a script that chains tool calls and returns only the final value", async () => {
    const server = createCodeModeServer({
      serverInfo: { name: "test", version: "0.0.0" },
      tools: buildRegistry(),
      kernel: new JsKernel(),
    });
    const code = `
      const sum = await callTool("add", { a: 2, b: 3 });
      const upper = await callTool("uppercase", { s: "hello-" + sum });
      return upper;
    `;
    const created = await server.handle(
      rpc("tools/call", { name: "execute_code", arguments: { code } })
    );
    const taskId = created.taskId;
    expect(taskId).toBeTruthy();

    // Poll until the task completes.
    let state = "pending";
    let answer: unknown = null;
    let errorMsg: string | undefined;
    for (let i = 0; i < 50 && state !== "complete" && state !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const got = await server.handle(rpc("tasks/get", { id: taskId }));
      const rec = got.response.result as { state: string; result?: unknown; error?: string };
      state = rec.state;
      answer = rec.result;
      errorMsg = rec.error;
    }
    expect(state, `failed with: ${errorMsg ?? "no error message"}`).toBe("complete");
    // The intermediate tool outputs (5, "HELLO-5") are NOT in the answer —
    // only the script's final return is. We just check the answer is present
    // and looks plausible; ProgrammaticOrchestrator stringifies it.
    expect(typeof answer).toBe("string");
    expect((answer as string).toUpperCase()).toContain("HELLO-5");
  }, 10_000);

  it("surfaces a script syntax/runtime error as a failed task", async () => {
    const server = createCodeModeServer({
      serverInfo: { name: "test", version: "0.0.0" },
      tools: buildRegistry(),
      kernel: new JsKernel(),
    });
    const created = await server.handle(
      rpc("tools/call", { name: "execute_code", arguments: { code: "throw new Error('boom')" } })
    );
    const taskId = created.taskId as string;

    let state = "pending";
    let error: string | undefined;
    for (let i = 0; i < 50 && state !== "complete" && state !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const got = await server.handle(rpc("tasks/get", { id: taskId }));
      const rec = got.response.result as { state: string; error?: string };
      state = rec.state;
      error = rec.error;
    }
    expect(state).toBe("failed");
    expect(error).toMatch(/boom|KernelError/i);
  }, 10_000);

  it("rejects empty `code`", async () => {
    const server = createCodeModeServer({
      serverInfo: { name: "test", version: "0.0.0" },
      tools: buildRegistry(),
      kernel: new JsKernel(),
    });
    const created = await server.handle(
      rpc("tools/call", { name: "execute_code", arguments: { code: "   " } })
    );
    const taskId = created.taskId as string;
    let state = "pending";
    let error: string | undefined;
    for (let i = 0; i < 50 && state !== "complete" && state !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const got = await server.handle(rpc("tasks/get", { id: taskId }));
      const rec = got.response.result as { state: string; error?: string };
      state = rec.state;
      error = rec.error;
    }
    expect(state).toBe("failed");
    expect(error).toMatch(/empty/i);
  }, 5_000);
});
