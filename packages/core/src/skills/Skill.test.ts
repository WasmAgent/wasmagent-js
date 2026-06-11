/**
 * A3 — SkillRegistry tests.
 *
 * Verifies the contract from Skill.ts:
 *   - register / list reflects state without loading bodies
 *   - match runs triggers cheaply; no body loading
 *   - activate lazily loads + caches the body
 *   - resolveForTask composes match + activate into instructions + tools
 *   - duplicate registration throws; unknown activation throws
 *   - flaky triggers don't crash the run; they're treated as no-match
 */

import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../tools/types.js";
import { SkillRegistry } from "./Skill.js";
import { z } from "zod";

function fakeTool(name: string): ToolDefinition {
  return {
    name,
    description: `fake tool ${name}`,
    inputSchema: z.object({}),
    outputSchema: z.string(),
    readOnly: true,
    idempotent: true,
    forward: async () => `(${name} ran)`,
  } satisfies ToolDefinition;
}

describe("SkillRegistry", () => {
  it("register/list exposes manifests without loading bodies", () => {
    const registry = new SkillRegistry();
    let loadCount = 0;
    registry.register({
      name: "skill-a",
      description: "does A things",
      load: () => {
        loadCount += 1;
        return { instructions: "do A" };
      },
    });
    registry.register({
      name: "skill-b",
      description: "does B things",
      tags: ["beta"],
      load: () => ({ instructions: "do B" }),
    });
    const manifests = registry.list();
    expect(manifests.length).toBe(2);
    expect(manifests[0]?.name).toBe("skill-a");
    expect(manifests[1]?.tags).toEqual(["beta"]);
    expect(loadCount).toBe(0); // list does NOT load bodies
  });

  it("describe renders a markdown bullet list", () => {
    const registry = new SkillRegistry();
    registry.register({ name: "a", description: "Aa", load: () => ({ instructions: "" }) });
    const md = registry.describe();
    expect(md).toContain("**a** — Aa");
  });

  it("match runs triggers but does not load bodies", async () => {
    const registry = new SkillRegistry();
    let loaded = 0;
    registry.register({
      name: "react-build",
      description: "scaffold a React app",
      trigger: (task) => /react|vite/i.test(task),
      load: () => {
        loaded += 1;
        return { instructions: "react!" };
      },
    });
    registry.register({
      name: "data-analysis",
      description: "pandas-style analysis",
      trigger: (task) => /pandas|csv/i.test(task),
      load: () => ({ instructions: "data!" }),
    });
    const matched = await registry.match("Build a React component using Vite");
    expect(matched.length).toBe(1);
    expect(matched[0]?.name).toBe("react-build");
    expect(loaded).toBe(0); // match does NOT load
  });

  it("match skips skills without a trigger", async () => {
    const registry = new SkillRegistry();
    registry.register({
      name: "explicit-only",
      description: "must be activated by name",
      load: () => ({ instructions: "x" }),
    });
    expect(await registry.match("anything")).toEqual([]);
  });

  it("activate loads the body lazily and caches across activations", async () => {
    const registry = new SkillRegistry();
    let loaded = 0;
    registry.register({
      name: "lazy",
      description: "loads on demand",
      load: async () => {
        loaded += 1;
        return { instructions: "lazy body" };
      },
    });
    expect(loaded).toBe(0);
    const a = await registry.activate("lazy");
    expect(a.body.instructions).toBe("lazy body");
    expect(loaded).toBe(1);
    const b = await registry.activate("lazy");
    expect(b.body.instructions).toBe("lazy body");
    expect(loaded).toBe(1); // cached
  });

  it("activate throws for unknown skill", async () => {
    const registry = new SkillRegistry();
    await expect(registry.activate("nope")).rejects.toThrow(/not registered/);
  });

  it("duplicate registration throws", () => {
    const registry = new SkillRegistry();
    registry.register({ name: "a", description: "x", load: () => ({ instructions: "" }) });
    expect(() =>
      registry.register({ name: "a", description: "y", load: () => ({ instructions: "" }) }),
    ).toThrow(/already registered/);
  });

  it("resolveForTask merges instructions + tools from all matched skills", async () => {
    const registry = new SkillRegistry();
    registry.register({
      name: "react-build",
      description: "react",
      trigger: (t) => /react/i.test(t),
      load: () => ({
        instructions: "Use functional components with hooks.",
        tools: [fakeTool("scaffold_react")],
      }),
    });
    registry.register({
      name: "tailwind-style",
      description: "tailwind",
      trigger: (t) => /tailwind/i.test(t),
      load: () => ({
        instructions: "Default to utility-first classes.",
        tools: [fakeTool("inline_tailwind"), fakeTool("scan_classes")],
      }),
    });
    const resolved = await registry.resolveForTask(
      "Make a React form with Tailwind v3",
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.activated).toEqual(["react-build", "tailwind-style"]);
    expect(resolved!.instructions).toContain("Skill: react-build");
    expect(resolved!.instructions).toContain("Skill: tailwind-style");
    expect(resolved!.tools.map((t) => t.name)).toEqual([
      "scaffold_react",
      "inline_tailwind",
      "scan_classes",
    ]);
  });

  it("resolveForTask returns null when nothing matches", async () => {
    const registry = new SkillRegistry();
    registry.register({
      name: "react-build",
      description: "react",
      trigger: () => false,
      load: () => ({ instructions: "" }),
    });
    expect(await registry.resolveForTask("hello world")).toBeNull();
  });

  it("flaky triggers are treated as no-match (the run keeps going)", async () => {
    const registry = new SkillRegistry();
    registry.register({
      name: "bad",
      description: "throws on trigger",
      trigger: () => {
        throw new Error("boom");
      },
      load: () => ({ instructions: "" }),
    });
    registry.register({
      name: "good",
      description: "matches everything",
      trigger: () => true,
      load: () => ({ instructions: "ok" }),
    });
    const matched = await registry.match("anything");
    expect(matched.map((m) => m.name)).toEqual(["good"]);
  });
});
