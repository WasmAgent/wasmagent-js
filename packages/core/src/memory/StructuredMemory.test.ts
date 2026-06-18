import { z } from "zod";
import { InMemoryStructuredKv, StructuredMemory } from "./StructuredMemory.js";

const newMem = () => new StructuredMemory(new InMemoryStructuredKv());

describe("StructuredMemory.set/get", () => {
  it("round-trips a value", async () => {
    const m = newMem();
    await m.set("user:42", { name: "Alice", role: "admin" });
    const v = await m.get<{ name: string; role: string }>("user:42");
    expect(v).toEqual({ name: "Alice", role: "admin" });
  });

  it("returns null for missing keys", async () => {
    const m = newMem();
    expect(await m.get("nope")).toBeNull();
  });

  it("default namespace is episodic", async () => {
    const m = newMem();
    await m.set("k", "v");
    expect(await m.get("k", "episodic")).toBe("v");
    expect(await m.get("k", "semantic")).toBeNull();
  });

  it("supports semantic namespace with no auto-expiry", async () => {
    const m = newMem();
    await m.set("fact:1", "the sky is blue", { namespace: "semantic" });
    expect(await m.get("fact:1", "semantic")).toBe("the sky is blue");
  });

  it("zod schema validates value on set", async () => {
    const m = newMem();
    const schema = z.object({ count: z.number() });
    await expect(
      m.set("k", { count: "not-a-number" } as unknown as { count: number }, { schema })
    ).rejects.toThrow(/schema validation failed/);
  });

  it("get() updates accessCount metadata", async () => {
    const m = newMem();
    await m.set("k", "v");
    await m.get("k");
    await m.get("k");
    // wait for the best-effort write-back microtasks
    await new Promise((r) => setTimeout(r, 5));
    const entries = await m.query({ namespace: "episodic" });
    const entry = entries.find((e) => e.key === "k");
    expect(entry?.accessCount).toBeGreaterThanOrEqual(1);
  });
});

describe("StructuredMemory.query", () => {
  it("filters by namespace", async () => {
    const m = newMem();
    await m.set("a", 1, { namespace: "episodic" });
    await m.set("b", 2, { namespace: "semantic" });
    await m.set("c", 3, { namespace: "procedural" });
    const ep = await m.query({ namespace: "episodic" });
    expect(ep.map((e) => e.key)).toEqual(["a"]);
    const all = await m.query();
    expect(all).toHaveLength(3);
  });

  it("filters by tags (all required)", async () => {
    const m = newMem();
    await m.set("a", 1, { tags: ["x", "y"] });
    await m.set("b", 2, { tags: ["x"] });
    const out = await m.query({ tags: ["x", "y"] });
    expect(out.map((e) => e.key)).toEqual(["a"]);
  });

  it("filters by time range", async () => {
    const m = newMem();
    const _t = Date.now();
    await m.set("a", 1);
    await new Promise((r) => setTimeout(r, 5));
    const cut = Date.now();
    await m.set("b", 2);
    const before = await m.query({ before: cut });
    expect(before.map((e) => e.key)).toEqual(["a"]);
    const after = await m.query({ after: cut - 1 });
    expect(after.map((e) => e.key)).toContain("b");
  });
});

describe("StructuredMemory.decay", () => {
  it("does not delete fresh entries", async () => {
    const m = newMem();
    await m.set("a", 1);
    const r = await m.decay();
    expect(r.purged).toBe(0);
  });

  it("deletes entries past their ttlMs", async () => {
    const m = newMem();
    await m.set("short", "v", { ttlMs: 5 });
    await new Promise((res) => setTimeout(res, 20));
    const r = await m.decay();
    expect(r.purged).toBe(1);
    expect(await m.get("short")).toBeNull();
  });

  it("dryRun reports without deleting", async () => {
    const m = newMem();
    await m.set("short", "v", { ttlMs: 5 });
    await new Promise((res) => setTimeout(res, 20));
    const r = await m.decay({ dryRun: true });
    expect(r.purged).toBe(1);
    // entry should still be reachable through the underlying store
    expect(await m.count()).toBe(1);
  });

  it("evicts cold episodic entries (accessCount=0, > 30 days)", async () => {
    const m = newMem();
    await m.set("cold", "v");
    // simulate that 31 days have passed
    const future = Date.now() + 31 * 24 * 60 * 60 * 1000;
    const r = await m.decay({ now: future });
    expect(r.purged).toBe(1);
  });

  it("does NOT evict semantic entries even if old", async () => {
    const m = newMem();
    await m.set("fact", "v", { namespace: "semantic" });
    const future = Date.now() + 365 * 24 * 60 * 60 * 1000;
    const r = await m.decay({ now: future });
    expect(r.purged).toBe(0);
  });

  it("count() reports per-namespace and total", async () => {
    const m = newMem();
    await m.set("a", 1, { namespace: "episodic" });
    await m.set("b", 2, { namespace: "semantic" });
    expect(await m.count("episodic")).toBe(1);
    expect(await m.count("semantic")).toBe(1);
    expect(await m.count()).toBe(2);
  });
});
