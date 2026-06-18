/**
 * BranchableWorkspace — F3 tests.
 *
 * Pin down the contract the v3 plan asks for:
 *   - fork() is O(1) — no file content is copied (asserted by KV write count);
 *   - parallel branches editing different files merge cleanly;
 *   - parallel branches editing the same file produce a structured conflict
 *     and never silently overwrite;
 *   - tombstones survive across the parent chain (no resurrection);
 *   - diff() reports added / modified / deleted with the right shape;
 *   - merge strategies "ours" / "theirs" act as documented;
 *   - branch isolation: writes never leak across siblings.
 */

import { MapKvBackend } from "../memory/MemoryTool.js";
import {
  BranchableWorkspace,
  type MergeConflict,
  openOrCreateRoot,
} from "./BranchableWorkspace.js";

/**
 * Counting KV adapter — every operation on the inner backend is recorded so
 * we can assert "fork is O(1)" and "1000-file fork ≠ 1000 writes".
 */
class CountingKv {
  putCount = 0;
  getCount = 0;
  delCount = 0;
  listCount = 0;
  constructor(private readonly inner: MapKvBackend) {}
  async get(k: string): Promise<string | null> {
    this.getCount++;
    return this.inner.get(k);
  }
  async put(k: string, v: string): Promise<void> {
    this.putCount++;
    return this.inner.put(k, v);
  }
  async delete(k: string): Promise<void> {
    this.delCount++;
    return this.inner.delete(k);
  }
  async list(prefix: string): Promise<string[]> {
    this.listCount++;
    return this.inner.list(prefix);
  }
}

describe("BranchableWorkspace — construction", () => {
  it("rejects a KvBackend without list()", () => {
    const noList = { get: async () => null, put: async () => {}, delete: async () => {} };
    expect(() => new BranchableWorkspace(noList, "x")).toThrow(/list/);
  });

  it("rejects branchIds containing whitespace or our key separator", () => {
    const kv = new MapKvBackend();
    expect(() => new BranchableWorkspace(kv, "")).toThrow(/branchId/);
    expect(() => new BranchableWorkspace(kv, "with space")).toThrow(/branchId/);
    expect(() => new BranchableWorkspace(kv, "has:colon")).toThrow(/branchId/);
  });

  it("init() is idempotent — calling twice does not reparent", async () => {
    const kv = new MapKvBackend();
    const ws = new BranchableWorkspace(kv, "main");
    await ws.init(null);
    await ws.init("would-reparent-if-broken");
    // Read raw meta to confirm parent stayed null.
    const raw = await kv.get("wsmeta:main");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).parent).toBeNull();
  });
});

describe("BranchableWorkspace — read/write/list", () => {
  it("read returns null for missing files; write+read round-trips", async () => {
    const kv = new MapKvBackend();
    const ws = await openOrCreateRoot(kv);
    expect(await ws.read("foo.ts")).toBeNull();
    await ws.write("foo.ts", "hello");
    expect(await ws.read("foo.ts")).toBe("hello");
    expect(await ws.exists("foo.ts")).toBe(true);
  });

  it("exists distinguishes empty-string from absent", async () => {
    const kv = new MapKvBackend();
    const ws = await openOrCreateRoot(kv);
    await ws.write("empty.txt", "");
    expect(await ws.exists("empty.txt")).toBe(true);
    expect(await ws.read("empty.txt")).toBe("");
    expect(await ws.exists("ghost.txt")).toBe(false);
  });

  it("list returns visible paths, sorted, with tombstones applied", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    await root.write("b.ts", "1");
    await root.write("a.ts", "1");
    await root.write("c.ts", "1");
    expect(await root.list()).toEqual(["a.ts", "b.ts", "c.ts"]);
    await root.remove("b.ts");
    expect(await root.list()).toEqual(["a.ts", "c.ts"]);
  });
});

describe("BranchableWorkspace — fork (copy-on-write)", () => {
  it("fork() of a 1000-file workspace performs O(1) writes — only metadata", async () => {
    const inner = new MapKvBackend();
    const counter = new CountingKv(inner);
    const root = await openOrCreateRoot(counter);
    for (let i = 0; i < 1000; i++) await root.write(`f${i}.ts`, `c${i}`);

    const writesBeforeFork = counter.putCount;
    const child = await root.fork("child-1");
    const writesByFork = counter.putCount - writesBeforeFork;

    // The fork itself wrote exactly the child's metadata: one put.
    expect(writesByFork).toBe(1);
    // And the child can read every file from the parent without touching them.
    expect(await child.read("f0.ts")).toBe("c0");
    expect(await child.read("f999.ts")).toBe("c999");
  });

  it("child sees parent files transparently; parent does not see child writes", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    await root.write("shared.ts", "v1");
    const child = await root.fork("c1");
    expect(await child.read("shared.ts")).toBe("v1");

    await child.write("only-child.ts", "child-content");
    expect(await child.read("only-child.ts")).toBe("child-content");
    expect(await root.read("only-child.ts")).toBeNull();
  });

  it("child write of a parent path shadows the parent without mutating it", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    await root.write("config.ts", "parent");
    const child = await root.fork("c");
    await child.write("config.ts", "child");
    expect(await child.read("config.ts")).toBe("child");
    expect(await root.read("config.ts")).toBe("parent");
  });

  it("tombstone hides parent file on child only; sibling fork still sees it", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    await root.write("doomed.ts", "v");
    const a = await root.fork("a");
    const b = await root.fork("b");
    await a.remove("doomed.ts");
    expect(await a.read("doomed.ts")).toBeNull();
    expect(await b.read("doomed.ts")).toBe("v");
    expect(await root.read("doomed.ts")).toBe("v");
  });

  it("re-writing a tombstoned path lifts the tombstone", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    await root.write("x.ts", "v1");
    const child = await root.fork("c");
    await child.remove("x.ts");
    expect(await child.read("x.ts")).toBeNull();
    await child.write("x.ts", "v2");
    expect(await child.read("x.ts")).toBe("v2");
  });
});

describe("BranchableWorkspace — diff", () => {
  it("reports added / modified / deleted relative to base", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    await root.write("keep.ts", "0");
    await root.write("change.ts", "0");
    await root.write("gone.ts", "0");

    const child = await root.fork("c");
    await child.write("change.ts", "1");
    await child.remove("gone.ts");
    await child.write("new.ts", "fresh");

    const changes = await child.diff(root);
    expect(changes).toEqual([
      { path: "change.ts", kind: "modified", content: "1" },
      { path: "gone.ts", kind: "deleted", content: null },
      { path: "new.ts", kind: "added", content: "fresh" },
    ]);
  });

  it("does not report files written-then-restored to the parent's content", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    await root.write("a.ts", "v1");
    const child = await root.fork("c");
    await child.write("a.ts", "v1"); // same content
    const changes = await child.diff(root);
    expect(changes.find((c) => c.path === "a.ts")).toBeUndefined();
  });

  it("rejects diff against a non-ancestor", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    const a = await root.fork("a");
    const b = await root.fork("b");
    await expect(a.diff(b)).rejects.toThrow(/ancestor/);
  });
});

describe("BranchableWorkspace — merge", () => {
  it("merges disjoint changes from two siblings cleanly", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    await root.write("a.ts", "0");
    await root.write("b.ts", "0");
    const left = await root.fork("L");
    const right = await root.fork("R");
    await left.write("a.ts", "L");
    await right.write("b.ts", "R");

    const result = await left.merge(right);
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual(["b.ts"]);
    expect(await left.read("a.ts")).toBe("L");
    expect(await left.read("b.ts")).toBe("R");
  });

  it("default strategy surfaces a both-modified conflict and does not overwrite", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    await root.write("file.ts", "v0");
    const left = await root.fork("L");
    const right = await root.fork("R");
    await left.write("file.ts", "v-left");
    await right.write("file.ts", "v-right");

    const result = await left.merge(right);
    expect(result.conflicts).toHaveLength(1);
    const c = result.conflicts[0] as MergeConflict;
    expect(c).toMatchObject({
      path: "file.ts",
      ours: "v-left",
      theirs: "v-right",
      reason: "both-modified",
    });
    expect(result.applied).not.toContain("file.ts");
    // Crucially: the left branch was NOT silently rewritten.
    expect(await left.read("file.ts")).toBe("v-left");
  });

  it("modified-vs-deleted lands as a structured conflict, not a silent loss", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    await root.write("doc.md", "# original");
    const left = await root.fork("L");
    const right = await root.fork("R");
    await left.write("doc.md", "# updated");
    await right.remove("doc.md");

    const result = await left.merge(right);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      path: "doc.md",
      reason: "modified-vs-deleted",
      ours: "# updated",
      theirs: null,
    });
    expect(await left.read("doc.md")).toBe("# updated");
  });

  it("identical edits on both sides collapse without a conflict", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    await root.write("same.ts", "v0");
    const left = await root.fork("L");
    const right = await root.fork("R");
    await left.write("same.ts", "agreed");
    await right.write("same.ts", "agreed");
    const result = await left.merge(right);
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toContain("same.ts");
  });

  it("strategy: theirs applies the other side and clears the conflict list", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    await root.write("file.ts", "v0");
    const left = await root.fork("L");
    const right = await root.fork("R");
    await left.write("file.ts", "v-left");
    await right.write("file.ts", "v-right");

    const result = await left.merge(right, "theirs");
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toContain("file.ts");
    expect(await left.read("file.ts")).toBe("v-right");
  });

  it("strategy: ours leaves the receiver untouched", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv);
    await root.write("file.ts", "v0");
    const left = await root.fork("L");
    const right = await root.fork("R");
    await left.write("file.ts", "v-left");
    await right.write("file.ts", "v-right");

    const result = await left.merge(right, "ours");
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toContain("file.ts");
    expect(await left.read("file.ts")).toBe("v-left");
  });

  it("rejects merge when there is no common ancestor", async () => {
    const kv = new MapKvBackend();
    const root = await openOrCreateRoot(kv, "rootA");
    const otherRoot = await openOrCreateRoot(kv, "rootB");
    await expect(root.merge(otherRoot)).rejects.toThrow(/ancestor/);
  });
});
