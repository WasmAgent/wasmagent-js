import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStructuredKv } from "./fileKv.js";
import { StructuredMemory } from "./StructuredMemory.js";

function tmpPath(): string {
  return join(
    tmpdir(),
    `wasmagent-filekv-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
}

function cleanup(path: string) {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best effort
  }
}

describe("FileStructuredKv", () => {
  it("persists data to disk and reloads on construction", async () => {
    const p = tmpPath();
    try {
      const kv1 = new FileStructuredKv(p);
      await kv1.put("hello", "world");
      await kv1.set("foo", "bar");

      // Create a new instance that reads from the same file
      const kv2 = new FileStructuredKv(p);
      expect(await kv2.get("hello")).toBe("world");
      expect(await kv2.get("foo")).toBe("bar");
    } finally {
      cleanup(p);
    }
  });

  it("returns null for missing keys", async () => {
    const p = tmpPath();
    try {
      const kv = new FileStructuredKv(p);
      expect(await kv.get("nope")).toBeNull();
    } finally {
      cleanup(p);
    }
  });

  it("delete() removes key and persists removal", async () => {
    const p = tmpPath();
    try {
      const kv1 = new FileStructuredKv(p);
      await kv1.put("a", "1");
      await kv1.put("b", "2");
      await kv1.delete("a");

      const kv2 = new FileStructuredKv(p);
      expect(await kv2.get("a")).toBeNull();
      expect(await kv2.get("b")).toBe("2");
    } finally {
      cleanup(p);
    }
  });

  it("list() filters by prefix", async () => {
    const p = tmpPath();
    try {
      const kv = new FileStructuredKv(p);
      await kv.put("mem:episodic:a", "1");
      await kv.put("mem:episodic:b", "2");
      await kv.put("mem:semantic:c", "3");

      const episodic = await kv.list("mem:episodic:");
      expect(episodic.sort()).toEqual(["mem:episodic:a", "mem:episodic:b"]);

      const semantic = await kv.list("mem:semantic:");
      expect(semantic).toEqual(["mem:semantic:c"]);
    } finally {
      cleanup(p);
    }
  });

  it("works as a StructuredMemory backend", async () => {
    const p = tmpPath();
    try {
      const kv = new FileStructuredKv(p);
      const mem = new StructuredMemory(kv);
      await mem.set("user:1", { name: "Alice" }, { namespace: "semantic" });
      const val = await mem.get<{ name: string }>("user:1", "semantic");
      expect(val).toEqual({ name: "Alice" });

      // Verify persistence
      const kv2 = new FileStructuredKv(p);
      const mem2 = new StructuredMemory(kv2);
      const val2 = await mem2.get<{ name: string }>("user:1", "semantic");
      expect(val2).toEqual({ name: "Alice" });
    } finally {
      cleanup(p);
    }
  });

  it("handles corrupt file gracefully by starting fresh", async () => {
    const p = tmpPath();
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(p, "not valid json {{{{");
      const kv = new FileStructuredKv(p);
      expect(await kv.get("any")).toBeNull();
      await kv.put("x", "y");
      expect(await kv.get("x")).toBe("y");
    } finally {
      cleanup(p);
    }
  });
});
