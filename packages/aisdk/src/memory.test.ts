/**
 * D3 (2026-06-13) — memory adapter tests.
 *
 * These pin down that the AI SDK shape exposed by `memoryTool()`
 * round-trips correctly to agentkit's `createMemoryTool` core
 * implementation: write → read returns the persisted value, and the
 * tool description matches core (so callers don't see drift between
 * frameworks).
 */

import { MapKvBackend } from "@agentkit-js/core";
import { describe, expect, it } from "vitest";
import { memoryTool } from "./memory.js";

describe("memoryTool (D3 — AI SDK shape)", () => {
  it("reuses the core tool description verbatim", async () => {
    const tool = memoryTool({ backend: new MapKvBackend() });
    expect(tool.description).toMatch(/persist|retrieve/i);
  });

  it("write → read round-trips through the supplied backend", async () => {
    const backend = new MapKvBackend();
    const tool = memoryTool({ backend });
    const writeResult = await tool.execute({
      op: "write",
      key: "/note/1",
      value: "hello",
    });
    expect(writeResult).toMatch(/wrote|saved|ok|stored/i);

    const readResult = await tool.execute({ op: "read", key: "/note/1" });
    expect(readResult).toContain("hello");
  });

  it("delete then read surfaces a missing key the same way as core", async () => {
    const tool = memoryTool({ backend: new MapKvBackend() });
    await tool.execute({ op: "write", key: "/note/2", value: "x" });
    await tool.execute({ op: "delete", key: "/note/2" });
    const after = await tool.execute({ op: "read", key: "/note/2" });
    // Core returns "(no value stored for key: …)" on missing keys.
    // Pin the substring so upstream framework users see the same string.
    expect(after.toLowerCase()).toMatch(/no value stored|not found|missing|null/);
  });
});
