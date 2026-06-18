/**
 * stdio.test.ts — coverage for the newline-delimited JSON-RPC stdio
 * transport added 2026-06-12 to satisfy `awesome-mcp-servers#7910`'s
 * Glama listing requirement.
 *
 * We do NOT spawn the bin in a child process here — that would slow
 * the test suite down for no good reason. Instead we exercise
 * `runStdio()` directly with `Readable.from()` for stdin and a
 * write-spy for stdout. The framing rules are what matter.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { Readable } from "node:stream";
import { ToolRegistry, VmKernel } from "@wasmagent/core";
import { createCodeModeServer } from "./codeMode.js";
import { runStdio } from "./stdio.js";

function buildServer() {
  return createCodeModeServer({
    tools: new ToolRegistry(),
    kernel: new VmKernel(),
    serverInfo: { name: "test-mcp", version: "0.0.0" },
  });
}

/**
 * Run a list of pre-canned client→server messages through `runStdio()`
 * and collect everything written to stdout as parsed JSON objects.
 *
 * stdin is closed after the last line so `runStdio` resolves and we
 * can assert on a stable batch of output.
 */
async function driveStdio(lines: string[]): Promise<Record<string, unknown>[]> {
  const server = buildServer();
  const out: Record<string, unknown>[] = [];

  const stdinSrc = Readable.from(lines.map((l) => `${l}\n`));
  const stdinSpy = spyOn(process, "stdin", "get").mockReturnValue(stdinSrc as never);
  const writeSpy = spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      // The contract: one JSON object per write, terminated by exactly one \n.
      // If a future change ever splits an object across writes we want the
      // test to fail loudly, not silently re-assemble.
      expect(s.endsWith("\n")).toBe(true);
      const trimmed = s.slice(0, -1);
      // Each chunk MUST be exactly one JSON value (no embedded \n).
      expect(trimmed.includes("\n")).toBe(false);
      out.push(JSON.parse(trimmed) as Record<string, unknown>);
      return true;
    }
  );

  try {
    await runStdio(server);
  } finally {
    writeSpy.mockRestore();
    stdinSpy.mockRestore();
  }
  return out;
}

describe("runStdio", () => {
  it("answers initialize / tools/list / ping in order", async () => {
    const out = await driveStdio([
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
    ]);

    expect(out.length).toBe(3);
    const initRes = out.find((r) => r.id === 1) as { result?: { protocolVersion?: string } };
    const listRes = out.find((r) => r.id === 2) as {
      result?: { tools?: Array<{ name: string }> };
    };
    const pingRes = out.find((r) => r.id === 3) as { result?: unknown };

    expect(initRes?.result?.protocolVersion).toBe("2025-11-25");
    const toolNames = listRes?.result?.tools?.map((t) => t.name) ?? [];
    // Code-mode server publishes exactly two tools.
    expect(toolNames.sort()).toEqual(["docs_search", "execute_code"]);
    expect(pingRes?.result).toEqual({});
  });

  it("emits a -32700 parse-error for malformed JSON, with id null", async () => {
    const out = await driveStdio([
      "{not valid json",
      JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }),
    ]);

    const parseErr = out.find(
      (r) => (r as { error?: { code?: number } }).error?.code === -32700
    ) as { id: unknown; error: { code: number } };
    expect(parseErr).toBeTruthy();
    // Per JSON-RPC 2.0 spec: parse errors that prevent reading the request
    // id MUST report id=null.
    expect(parseErr.id).toBe(null);

    // The valid line still gets answered.
    expect(out.find((r) => r.id === 99)).toBeTruthy();
  });

  it("does NOT respond to notifications (no id field)", async () => {
    const out = await driveStdio([
      JSON.stringify({ jsonrpc: "2.0", method: "ping" }), // notification — no id
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }), // request — has id
    ]);

    // Notifications never produce a wire response — even if the server
    // would otherwise have sent `result: {}`, runStdio must suppress it.
    expect(out.length).toBe(1);
    expect((out[0] as { id: unknown }).id).toBe(7);
  });

  it("tolerates blank lines between messages", async () => {
    const out = await driveStdio([
      "",
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      "",
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    ]);
    expect(out.length).toBe(2);
    expect(out.map((r) => r.id).sort()).toEqual([1, 2]);
  });

  // Note: a "no embedded newlines in a single chunk" test is implicit in
  // the driveStdio() write-spy — every chunk is asserted to end with
  // exactly one \n and contain no others. Adding a separate test that
  // exercises the same invariant via a long-running tools/call would
  // race against runStdio's stdin-closed exit; the chunk-level
  // assertion is the load-bearing check.
});
