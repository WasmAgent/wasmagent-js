import { describe, expect, it } from "bun:test";
import { detectRugPull, hashContent, snapshotTool } from "./toolDescriptorSnapshot.js";
import type { McpToolEntry } from "./types.js";

const TOOL: McpToolEntry = {
  name: "run_code",
  description: "Execute sandboxed JavaScript",
  inputSchema: { type: "object", properties: { code: { type: "string" } } },
};

describe("hashContent", () => {
  it("produces stable 64-char hex", () => {
    const h = hashContent("hello");
    expect(h).toHaveLength(64);
    expect(h).toBe(hashContent("hello"));
  });

  it("differs for different input", () => {
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });
});

describe("snapshotTool", () => {
  it("produces stable hashes for same input", () => {
    const s1 = snapshotTool(TOOL, "srv", { nowMs: 1000 });
    const s2 = snapshotTool(TOOL, "srv", { nowMs: 1000 });
    expect(s1.descriptionHash).toBe(s2.descriptionHash);
    expect(s1.inputSchemaHash).toBe(s2.inputSchemaHash);
  });

  it("sets firstSeenAt from nowMs", () => {
    const s = snapshotTool(TOOL, "srv", { nowMs: 42000 });
    expect(s.firstSeenAt).toBe(42000);
  });

  it("defaults trustTier to unknown", () => {
    const s = snapshotTool(TOOL, "srv");
    expect(s.trustTier).toBe("unknown");
  });

  it("respects explicit trustTier", () => {
    const s = snapshotTool(TOOL, "srv", { trustTier: "trusted" });
    expect(s.trustTier).toBe("trusted");
  });
});

describe("detectRugPull", () => {
  const snap = snapshotTool(TOOL, "srv", { nowMs: 1000 });

  it("returns null when nothing changed", () => {
    expect(detectRugPull(snap, TOOL)).toBeNull();
  });

  it("detects description change", () => {
    const updated = { ...TOOL, description: "MALICIOUS OVERRIDE" };
    const event = detectRugPull(snap, updated);
    expect(event).not.toBeNull();
    expect(event!.field).toBe("description");
    expect(event!.oldHash).toBe(snap.descriptionHash);
    expect(event!.newHash).toBe(hashContent("MALICIOUS OVERRIDE"));
    expect(event!.toolName).toBe(TOOL.name);
  });

  it("detects inputSchema change", () => {
    const updated = { ...TOOL, inputSchema: { type: "object", properties: { evil: {} } } };
    const event = detectRugPull(snap, updated);
    expect(event).not.toBeNull();
    expect(event!.field).toBe("inputSchema");
  });

  it("reports description before inputSchema when both change", () => {
    const updated = {
      ...TOOL,
      description: "changed",
      inputSchema: { type: "object" },
    };
    const event = detectRugPull(snap, updated);
    expect(event!.field).toBe("description");
  });

  it("detectedAt is >= firstSeenAt", () => {
    const updated = { ...TOOL, description: "changed" };
    const event = detectRugPull(snap, updated)!;
    expect(event.detectedAt).toBeGreaterThanOrEqual(snap.firstSeenAt);
  });
});
