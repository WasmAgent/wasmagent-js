/**
 * #140 — Tests for three-way merge / conflict primitives.
 *
 * Covers: FieldTracker.dirtyKeys, threeWayMerge under each ConflictStrategy,
 * concurrent human+agent edits, non-overlapping clean merges, conflict
 * resolution rules, and conflicts surfaced into the projection via mergeDelta.
 */

import { describe, expect, it } from "bun:test";
import type { ConflictStrategy } from "./merge.js";
import { createFieldTracker, threeWayMerge } from "./merge.js";
import { createProjectionPipeline } from "./projection.js";
import { defineStateModel } from "./StateModel.js";

// ── #140 — FieldTracker / dirtyKeys ─────────────────────────────────────────

describe("FieldTracker.dirtyKeys", () => {
  it("returns keys whose value differs from baseline (mirrors dirtyFields)", () => {
    const tracker = createFieldTracker({ title: "A", body: "x", tags: ["a"] });
    const dirty = tracker.dirtyKeys({ title: "A", body: "y", tags: ["a"] });
    expect(dirty).toEqual(["body"]);
  });

  it("reports every changed key and skips unchanged ones", () => {
    const tracker = createFieldTracker({ a: 1, b: 2, c: 3 });
    const dirty = tracker.dirtyKeys({ a: 1, b: 99, c: 3 });
    expect(dirty).toEqual(["b"]);
  });

  it("treats a newly added key (absent in baseline) as dirty", () => {
    const tracker = createFieldTracker({ a: 1 });
    const dirty = tracker.dirtyKeys({ a: 1, newField: true });
    expect(dirty).toEqual(["newField"]);
  });

  it("uses structural equality — a structurally-equal replacement is NOT dirty", () => {
    // Same shape/value, fresh reference: must not count as dirty.
    const tracker = createFieldTracker({ nested: { x: 1 }, list: [1, 2] });
    const dirty = tracker.dirtyKeys({ nested: { x: 1 }, list: [1, 2] });
    expect(dirty).toEqual([]);
  });

  it("detects nested-object value changes as dirty", () => {
    const tracker = createFieldTracker({ nested: { x: 1 } });
    const dirty = tracker.dirtyKeys({ nested: { x: 2 } });
    expect(dirty).toEqual(["nested"]);
  });

  it("baseline is exposed on the tracker", () => {
    const tracker = createFieldTracker({ k: "v" });
    expect(tracker.baseline).toEqual({ k: "v" });
  });
});

// ── #140 — Non-overlapping edits merge cleanly under every strategy ─────────

describe("threeWayMerge: non-overlapping edits merge cleanly under all strategies", () => {
  const strategies: ConflictStrategy[] = ["last-write-wins", "agent-yields-to-human", "manual"];

  for (const strategy of strategies) {
    it(`merges disjoint human + agent edits with no conflicts [${strategy}]`, () => {
      const base = { a: 1, b: 2, c: 3 };
      const local = { a: 10, b: 2, c: 3 }; // human changed a
      const remote = { a: 1, b: 20, c: 3 }; // agent changed b

      const { merged, conflicts } = threeWayMerge(base, local, remote, strategy);

      expect(merged).toEqual({ a: 10, b: 20, c: 3 });
      expect(conflicts).toEqual([]);
    });
  }

  it("applies remote-only and local-only changes simultaneously", () => {
    const base = { keep: 0, humanOnly: "h0", agentOnly: "a0", shared: "s0" };
    const local = { keep: 0, humanOnly: "h1", shared: "s0" };
    const remote = { keep: 0, agentOnly: "a1", shared: "s0" };

    const { merged, conflicts } = threeWayMerge(base, local, remote, "manual");

    expect(merged).toEqual({ keep: 0, humanOnly: "h1", agentOnly: "a1", shared: "s0" });
    expect(conflicts).toEqual([]);
  });
});

// ── #140 — Conflict resolution per strategy ─────────────────────────────────

describe("threeWayMerge: conflict resolution", () => {
  // Both sides changed the same key to differing values → conflict.
  const base = { x: 1 };
  const local = { x: 2 }; // human
  const remote = { x: 3 }; // agent

  it("last-write-wins: the incoming agent (remote) write wins", () => {
    const { merged, conflicts } = threeWayMerge(base, local, remote, "last-write-wins");
    expect(merged.x).toBe(3);
    expect(conflicts).toEqual(["x"]);
  });

  it("agent-yields-to-human: the local (human) value wins on conflict", () => {
    const { merged, conflicts } = threeWayMerge(base, local, remote, "agent-yields-to-human");
    expect(merged.x).toBe(2);
    expect(conflicts).toEqual(["x"]);
  });

  it("manual: conflicted keys fall back to base and are reported unresolved", () => {
    const { merged, conflicts } = threeWayMerge(base, local, remote, "manual");
    expect(merged.x).toBe(1); // common-ancestor fallback, neither side's change applied
    expect(conflicts).toEqual(["x"]);
  });

  it("both sides change to the SAME value is not a conflict", () => {
    const { merged, conflicts } = threeWayMerge(
      { x: 1 },
      { x: 5 },
      { x: 5 },
      "agent-yields-to-human"
    );
    expect(merged.x).toBe(5);
    expect(conflicts).toEqual([]);
  });

  it("manual conflict on a key absent from base leaves it unresolved (undefined)", () => {
    // Both sides added the same key with differing values, no common ancestor.
    const { merged, conflicts } = threeWayMerge({}, { k: "L" }, { k: "R" }, "manual");
    expect(conflicts).toEqual(["k"]);
    expect(merged.k).toBeUndefined();
  });
});

// ── #140 — agent-yields-to-human semantics (headline criterion) ──────────────

describe("threeWayMerge: agent-yields-to-human", () => {
  it("for a key dirty in local, local wins even if remote also changed it", () => {
    const base = { title: "A", body: "x" };
    const local = { title: "A", body: "human" }; // human edited body
    const remote = { title: "B", body: "agent" }; // agent edited title + body

    const { merged, conflicts } = threeWayMerge(base, local, remote, "agent-yields-to-human");

    // Conflict on body → human wins.
    expect(merged.body).toBe("human");
    // Conflicted key is reported.
    expect(conflicts).toEqual(["body"]);
  });

  it("non-conflicting remote changes still apply", () => {
    const base = { title: "A", body: "x" };
    const local = { title: "A", body: "human" };
    const remote = { title: "B", body: "agent" };

    const { merged } = threeWayMerge(base, local, remote, "agent-yields-to-human");

    // title was changed only by the agent → agent write applies.
    expect(merged.title).toBe("B");
  });

  it("preserves a human edit the agent did not touch, alongside an agent edit", () => {
    const base = { a: 1, b: 1, c: 1 };
    const local = { a: 1, b: "human", c: 1 }; // human changed b
    const remote = { a: 1, b: 1, c: "agent" }; // agent changed c (disjoint)

    const { merged, conflicts } = threeWayMerge(base, local, remote, "agent-yields-to-human");
    expect(merged).toEqual({ a: 1, b: "human", c: "agent" });
    expect(conflicts).toEqual([]);
  });
});

// ── #140 — Additions / removals ─────────────────────────────────────────────

describe("threeWayMerge: additions and removals", () => {
  it("preserves human-only and agent-only additions (never silently dropped)", () => {
    const base = { shared: 1 };
    const local = { shared: 1, humanAdded: "h" };
    const remote = { shared: 1, agentAdded: "a" };

    const { merged, conflicts } = threeWayMerge(base, local, remote, "agent-yields-to-human");
    expect(merged).toEqual({ shared: 1, humanAdded: "h", agentAdded: "a" });
    expect(conflicts).toEqual([]);
  });

  it("drops a key removed from both sides", () => {
    const base = { keep: 1, drop: 2 };
    const local = { keep: 1 };
    const remote = { keep: 1 };

    const { merged } = threeWayMerge(base, local, remote, "last-write-wins");
    expect(merged).toEqual({ keep: 1 });
  });

  it("preserves a key the human kept when the agent removed it", () => {
    const base = { k: "base" };
    const local = { k: "human" }; // human still has (and changed) it
    const remote = {}; // agent removed it

    const { merged } = threeWayMerge(base, local, remote, "agent-yields-to-human");
    expect(merged).toEqual({ k: "human" });
  });
});

// ── #140 — Concurrent human + agent edits under each strategy ────────────────

describe("threeWayMerge: concurrent human + agent edits", () => {
  // Simulate two writers diverging from a shared base, then merging.
  const base = { title: "T0", body: "B0", tags: ["x"] };
  const human = { title: "T0", body: "B-human", tags: ["x"] }; // edited body
  const agent = { title: "T-agent", body: "B-agent", tags: ["x", "y"] }; // edited title+body, added tag

  it("agent-yields-to-human keeps the human edit and applies disjoint agent writes", () => {
    const { merged, conflicts } = threeWayMerge(base, human, agent, "agent-yields-to-human");
    expect(merged.body).toBe("B-human"); // conflict → human wins
    expect(merged.title).toBe("T-agent"); // disjoint agent write applies
    expect(merged.tags).toEqual(["x", "y"]); // disjoint agent addition applies
    expect(conflicts).toEqual(["body"]);
  });

  it("last-write-wins lets the agent overwrite the human edit on conflict", () => {
    const { merged, conflicts } = threeWayMerge(base, human, agent, "last-write-wins");
    expect(merged.body).toBe("B-agent"); // agent wins
    expect(merged.title).toBe("T-agent");
    expect(conflicts).toEqual(["body"]);
  });

  it("manual leaves the conflict at base and surfaces it for the app", () => {
    const { merged, conflicts } = threeWayMerge(base, human, agent, "manual");
    expect(merged.body).toBe("B0"); // unresolved → common ancestor
    expect(merged.title).toBe("T-agent"); // disjoint agent write still applies
    expect(conflicts).toEqual(["body"]);
  });
});

// ── #140 — Conflicts surfaced into the projection ───────────────────────────

describe("ProjectionPipeline.mergeDelta: conflicts surfaced into projection", () => {
  // Identity projection (no project fn) → projection keys == state keys.
  const docModel = defineStateModel<{ title: string; body: string; tags: string[] }>({
    initial: () => ({ title: "", body: "", tags: [] }),
    reduce: (s) => s,
  });
  const pipeline = createProjectionPipeline(docModel);

  it("surfaces conflicted fields via delta.conflicts (agent-yields-to-human)", () => {
    const base = { title: "T0", body: "B0", tags: ["x"] };
    const local = { title: "T0", body: "B-human", tags: ["x"] };
    const remote = { title: "T-agent", body: "B-agent", tags: ["x"] };

    const delta = pipeline.mergeDelta(base, local, remote, "agent-yields-to-human");

    // Conflict on body is surfaced so the agent knows not to touch it.
    expect(delta.conflicts).toEqual(["body"]);
    // Disjoint agent write (title) appears as a changed projection field.
    expect(delta.changed).toHaveProperty("title", "T-agent");
    // Merged body is the human value (agent yielded).
    expect(delta.changed).toHaveProperty("body", "B-human");
  });

  it("manual strategy surfaces conflicts and keeps base values in the merged projection", () => {
    const base = { title: "T0", body: "B0", tags: ["x"] };
    const local = { title: "T0", body: "B-human", tags: ["x"] };
    const remote = { title: "T-agent", body: "B-agent", tags: ["x"] };

    const delta = pipeline.mergeDelta(base, local, remote, "manual");

    expect(delta.conflicts).toEqual(["body"]);
    // body unresolved → stays at base ("B0"), so it is NOT in `changed`.
    expect(delta.changed).not.toHaveProperty("body");
    // title still applies.
    expect(delta.changed).toHaveProperty("title", "T-agent");
  });

  it("reports no conflicts for non-overlapping edits", () => {
    const base = { title: "T0", body: "B0", tags: ["x"] };
    const local = { title: "T0", body: "B-human", tags: ["x"] };
    const remote = { title: "T-agent", body: "B0", tags: ["x"] };

    const delta = pipeline.mergeDelta(base, local, remote, "agent-yields-to-human");

    expect(delta.conflicts).toEqual([]);
    expect(delta.changed).toHaveProperty("title", "T-agent");
    expect(delta.changed).toHaveProperty("body", "B-human");
  });

  it("plain diff() does not populate conflicts (absent for two-state diffs)", () => {
    const prev = { title: "T0", body: "B0", tags: ["x"] };
    const next = { title: "T1", body: "B0", tags: ["x"] };

    const delta = pipeline.diff(prev, next);

    expect(delta.changed).toHaveProperty("title", "T1");
    expect(delta.conflicts).toBeUndefined();
  });

  it("works with a reshaping projection (conflict on a projected field)", () => {
    // project exposes `items` (and counts); a conflict on raw `items` surfaces
    // because `items` is also a projection field.
    const todoModel = defineStateModel<{ items: string[]; nextId: number }, { type: string }>({
      initial: () => ({ items: [], nextId: 1 }),
      reduce: (s) => s,
      project: (s) => ({ total: s.items.length, items: s.items }),
    });
    const todoPipeline = createProjectionPipeline(todoModel);

    const base = { items: ["a"], nextId: 2 };
    const local = { items: ["a", "human"], nextId: 2 };
    const remote = { items: ["a", "agent"], nextId: 2 };

    const delta = todoPipeline.mergeDelta(base, local, remote, "agent-yields-to-human");

    expect(delta.conflicts).toEqual(["items"]);
    // Merged projection carries the human-won items list.
    expect(delta.changed).toHaveProperty("items");
    expect(delta.changed.items as string[]).toEqual(["a", "human"]);
  });
});
