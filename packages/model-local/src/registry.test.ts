/**
 * Tests for the model registry and source ordering.
 *
 * No network — these are pure-logic tests against the static registry table.
 *
 * 2026-06-13 (V3): the registry was audited on real hardware and the
 * fictional `qwen3.5-0.8b` alias removed (no such checkpoint published).
 * `qwen2.5-1.5b` was added (Stage-0 ≤2GB winner from the parallel evomerge
 * eval). Tests reference `qwen2.5-1.5b` for cases that only need a
 * Qwen-with-modelscope-mirror entry; that's what every Qwen entry
 * provides.
 */

import {
  getRegisteredModel,
  listRegisteredModels,
  MODEL_REGISTRY,
  orderSources,
} from "./registry.js";

describe("registry", () => {
  it("registers all expected aliases", () => {
    expect(Object.keys(MODEL_REGISTRY).sort()).toEqual([
      "gemma-3-1b",
      "llama-3.2-1b",
      "qwen2.5-0.5b",
      "qwen2.5-1.5b",
      "qwen3-0.6b",
    ]);
  });

  it("each entry has at least one source and a license", () => {
    for (const m of listRegisteredModels()) {
      expect(m.sources.length).toBeGreaterThan(0);
      expect(m.license).toBeTruthy();
      expect(m.sizeBytes).toBeGreaterThan(0);
      // The first source must be the HF anchor, since sha256 (when set) is
      // declared relative to it.
      expect(m.sources[0]?.kind).toBe("huggingface");
    }
  });

  it("post-V3: every entry has a 64-char sha256 pinned (no placeholders)", () => {
    for (const m of listRegisteredModels()) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("getRegisteredModel throws on unknown alias", () => {
    expect(() => getRegisteredModel("nope")).toThrow(/Unknown model alias/);
  });

  it("Qwen models include the ModelScope mirror for PRC users", () => {
    const q = getRegisteredModel("qwen2.5-1.5b");
    const kinds = q.sources.map((s) => s.kind);
    expect(kinds).toContain("modelscope");
    expect(kinds).toContain("hf-mirror");
  });
});

describe("orderSources", () => {
  const m = getRegisteredModel("qwen2.5-1.5b");

  it("returns declared order with no mirror preference", () => {
    const ordered = orderSources(m);
    expect(ordered.map((s) => s.kind)).toEqual(m.sources.map((s) => s.kind));
  });

  it("promotes a matching mirror kind to position 0", () => {
    const ordered = orderSources(m, "hf-mirror");
    expect(ordered[0]?.kind).toBe("hf-mirror");
    // Original count is preserved.
    expect(ordered.length).toBe(m.sources.length);
  });

  it("promotes modelscope when requested", () => {
    const ordered = orderSources(m, "modelscope");
    expect(ordered[0]?.kind).toBe("modelscope");
  });

  it("synthesises a custom URL prefix when given a https:// mirror", () => {
    const ordered = orderSources(m, "https://cdn.example.com/models");
    expect(ordered[0]?.kind).toBe("url");
    expect(ordered[0]?.url).toMatch(/^https:\/\/cdn\.example\.com\/models\/qwen2\.5-1\.5b/);
    // The original sources are still present as fallbacks.
    expect(ordered.length).toBe(m.sources.length + 1);
  });

  it("ignores unknown mirror tokens (no string match, no scheme)", () => {
    const ordered = orderSources(m, "marsbase");
    expect(ordered.map((s) => s.kind)).toEqual(m.sources.map((s) => s.kind));
  });
});
