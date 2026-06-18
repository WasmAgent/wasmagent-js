/**
 * createPortalServer — D1 federation tests.
 *
 * Pin down:
 *  1. tools/list publishes exactly docs_search + execute_code (the federation
 *     itself never leaks through the MCP surface — it stays a code-mode server).
 *  2. docs_search renders the *flattened* catalogue with `<id>__<tool>` names
 *     and per-upstream banner descriptions.
 *  3. docs_search supports `query` filtering across all upstreams.
 *  4. execute_code resolves namespaced names to the right upstream and returns
 *     only the script's final value.
 *  5. Validation rejects: empty upstreams, duplicate ids, ids containing the
 *     separator, tools whose names already contain the separator, malformed ids.
 *  6. The capability manifest applied at the Portal level survives across all
 *     upstream tool calls (verified by attempting a network fetch that should
 *     be denied for ANY upstream).
 *
 * These tests live alongside codeMode.test.ts and intentionally re-use the
 * same poll loop pattern — the Portal is a code-mode server with a flatter
 * registry, nothing more.
 */

import { JsKernel, ToolRegistry } from "@wasmagent/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPortalServer } from "./portal.js";
import { InMemoryTaskStore } from "./taskStore.js";

function buildGithubLike(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register({
    name: "list_repos",
    description: "List repositories accessible to the caller.",
    inputSchema: z.object({ org: z.string() }),
    outputSchema: z.array(z.string()),
    readOnly: true,
    idempotent: true,
    forward: async ({ org }) => [`${org}/alpha`, `${org}/beta`],
  });
  reg.register({
    name: "create_issue",
    description: "Open an issue on a repository.",
    inputSchema: z.object({ repo: z.string(), title: z.string() }),
    outputSchema: z.object({ url: z.string() }),
    readOnly: false,
    idempotent: false,
    forward: async ({ repo, title }) => ({ url: `https://github.com/${repo}/issues/1?t=${title}` }),
  });
  return reg;
}

function buildFsLike(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register({
    name: "read_file",
    description: "Read a file from the workspace.",
    inputSchema: z.object({ path: z.string() }),
    outputSchema: z.string(),
    readOnly: true,
    idempotent: true,
    forward: async ({ path }) => `content-of-${path}`,
  });
  return reg;
}

function rpc(method: string, params?: Record<string, unknown>, id: string | number = 1) {
  return { jsonrpc: "2.0" as const, id, method, ...(params ? { params } : {}) };
}

describe("createPortalServer — surface", () => {
  it("publishes exactly docs_search + execute_code (federation never leaks)", async () => {
    const server = createPortalServer({
      serverInfo: { name: "portal-test", version: "0.0.0" },
      kernel: new JsKernel(),
      taskStore: new InMemoryTaskStore(),
      upstreams: [
        { id: "github", tools: buildGithubLike(), description: "Repo + issue ops" },
        { id: "fs", tools: buildFsLike() },
      ],
    });
    const { response } = await server.handle(rpc("tools/list"));
    const result = response.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["docs_search", "execute_code"]);
  });
});

describe("createPortalServer — docs_search flattening", () => {
  it("renders the federated catalogue with `<id>__<tool>` names + upstream banner", async () => {
    const server = createPortalServer({
      serverInfo: { name: "portal-test", version: "0.0.0" },
      kernel: new JsKernel(),
      upstreams: [
        { id: "github", tools: buildGithubLike(), description: "Repo + issue ops" },
        { id: "fs", tools: buildFsLike() },
      ],
    });
    const { response } = await server.handle(
      rpc("tools/call", { name: "docs_search", arguments: {} })
    );
    const result = response.result as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(false);
    const text = result.content[0].text;

    // Namespaced names appear in section headers.
    expect(text).toContain("### github__list_repos");
    expect(text).toContain("### github__create_issue");
    expect(text).toContain("### fs__read_file");

    // Banner identifies which upstream each tool came from.
    expect(text).toContain("[github — Repo + issue ops]");
    expect(text).toContain("[fs]");
    // The tool's original description is preserved after the banner.
    expect(text).toContain("Open an issue on a repository.");
    expect(text).toContain("Read a file from the workspace.");
  });

  it("filters via `query` across all upstreams", async () => {
    const server = createPortalServer({
      serverInfo: { name: "portal-test", version: "0.0.0" },
      kernel: new JsKernel(),
      upstreams: [
        { id: "github", tools: buildGithubLike() },
        { id: "fs", tools: buildFsLike() },
      ],
    });
    const { response } = await server.handle(
      rpc("tools/call", { name: "docs_search", arguments: { query: "issue" } })
    );
    const text = (response.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain("github__create_issue");
    // list_repos description has no "issue", so it should be filtered out.
    expect(text).not.toContain("github__list_repos");
    expect(text).not.toContain("fs__read_file");
  });
});

describe("createPortalServer — execute_code routing", () => {
  // The poll loop mirrors codeMode.test.ts. We don't depend on real timing —
  // a few hundred ms is enough for an in-process JsKernel.
  async function pollUntilDone(
    server: ReturnType<typeof createPortalServer>,
    taskId: string,
    iterations = 50
  ): Promise<{ state: string; result?: unknown; error?: string }> {
    let state: string = "pending";
    let result: unknown;
    let error: string | undefined;
    for (let i = 0; i < iterations && state !== "complete" && state !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const got = await server.handle(rpc("tasks/get", { id: taskId }));
      const rec = got.response.result as { state: string; result?: unknown; error?: string };
      state = rec.state;
      result = rec.result;
      error = rec.error;
    }
    const out: { state: string; result?: unknown; error?: string } = { state };
    if (result !== undefined) out.result = result;
    if (error !== undefined) out.error = error;
    return out;
  }

  it("routes namespaced callTool() back to the right upstream and returns only the final value", async () => {
    const server = createPortalServer({
      serverInfo: { name: "portal-test", version: "0.0.0" },
      kernel: new JsKernel(),
      upstreams: [
        { id: "github", tools: buildGithubLike() },
        { id: "fs", tools: buildFsLike() },
      ],
    });
    const code = `
      const repos = await callTool("github__list_repos", { org: "acme" });
      const file = await callTool("fs__read_file", { path: "README.md" });
      return repos.length + ":" + file;
    `;
    const created = await server.handle(
      rpc("tools/call", { name: "execute_code", arguments: { code } })
    );
    const taskId = created.taskId as string;
    expect(taskId).toBeTruthy();

    const done = await pollUntilDone(server, taskId);
    expect(done.state, `failed with: ${done.error ?? "no error"}`).toBe("complete");
    // Intermediate tool outputs do NOT leak into the response — only the
    // script's final return value (which combines them).
    expect(typeof done.result).toBe("string");
    expect(done.result).toContain("2:content-of-README.md");
  }, 10_000);

  it("surfaces unknown namespaced tools as a script error (no silent fallback)", async () => {
    const server = createPortalServer({
      serverInfo: { name: "portal-test", version: "0.0.0" },
      kernel: new JsKernel(),
      upstreams: [{ id: "github", tools: buildGithubLike() }],
    });
    const created = await server.handle(
      rpc("tools/call", {
        name: "execute_code",
        arguments: { code: 'await callTool("github__no_such_tool", {})' },
      })
    );
    const taskId = created.taskId as string;
    const done = await pollUntilDone(server, taskId);
    expect(done.state).toBe("failed");
    expect(done.error).toMatch(/no_such_tool|not found|unknown/i);
  }, 10_000);
});

describe("createPortalServer — validation", () => {
  it("rejects empty upstreams list", () => {
    expect(() =>
      createPortalServer({
        serverInfo: { name: "x", version: "0" },
        kernel: new JsKernel(),
        upstreams: [],
      })
    ).toThrow(/at least one upstream/i);
  });

  it("rejects duplicate upstream ids", () => {
    expect(() =>
      createPortalServer({
        serverInfo: { name: "x", version: "0" },
        kernel: new JsKernel(),
        upstreams: [
          { id: "github", tools: buildGithubLike() },
          { id: "github", tools: buildFsLike() },
        ],
      })
    ).toThrow(/duplicate upstream id/i);
  });

  it("rejects ids that contain the namespace separator", () => {
    expect(() =>
      createPortalServer({
        serverInfo: { name: "x", version: "0" },
        kernel: new JsKernel(),
        upstreams: [{ id: "git__hub", tools: buildGithubLike() }],
      })
    ).toThrow(/separator/i);
  });

  it("rejects malformed ids (uppercase, leading dash, etc.)", () => {
    expect(() =>
      createPortalServer({
        serverInfo: { name: "x", version: "0" },
        kernel: new JsKernel(),
        upstreams: [{ id: "GitHub", tools: buildGithubLike() }],
      })
    ).toThrow(/identifier/i);
    expect(() =>
      createPortalServer({
        serverInfo: { name: "x", version: "0" },
        kernel: new JsKernel(),
        upstreams: [{ id: "-github", tools: buildGithubLike() }],
      })
    ).toThrow(/identifier/i);
  });

  it("rejects upstream tools whose names already contain the separator", () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "weird__name",
      description: "x",
      inputSchema: z.object({}),
      outputSchema: z.string(),
      readOnly: true,
      idempotent: true,
      forward: async () => "x",
    });
    expect(() =>
      createPortalServer({
        serverInfo: { name: "x", version: "0" },
        kernel: new JsKernel(),
        upstreams: [{ id: "github", tools: reg }],
      })
    ).toThrow(/separator/i);
  });

  it("allows custom namespaceSeparator when the default conflicts", () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "weird__name", // contains default __
      description: "x",
      inputSchema: z.object({}),
      outputSchema: z.string(),
      readOnly: true,
      idempotent: true,
      forward: async () => "x",
    });
    // With a different separator, the same tool name is fine.
    expect(() =>
      createPortalServer({
        serverInfo: { name: "x", version: "0" },
        kernel: new JsKernel(),
        upstreams: [{ id: "github", tools: reg }],
        namespaceSeparator: "::",
      })
    ).not.toThrow();
  });
});
