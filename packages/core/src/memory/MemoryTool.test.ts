import { describe, expect, it } from "vitest";
import { createMemoryTool, MapKvBackend } from "../memory/MemoryTool.js";

describe("MemoryTool (L2-2)", () => {
  it("write and read round-trip persists a value", async () => {
    const backend = new MapKvBackend();
    const tool = createMemoryTool({ backend });

    const writeResult = await tool.forward({
      op: "write",
      key: "fact1",
      value: "Paris is the capital of France",
    });
    expect(writeResult).toBe("Stored: fact1");

    const readResult = await tool.forward({ op: "read", key: "fact1" });
    expect(readResult).toBe("Paris is the capital of France");
  });

  it("read missing key returns placeholder", async () => {
    const backend = new MapKvBackend();
    const tool = createMemoryTool({ backend });
    const result = await tool.forward({ op: "read", key: "nonexistent" });
    expect(result).toContain("nonexistent");
  });

  it("list returns stored keys", async () => {
    const backend = new MapKvBackend();
    const tool = createMemoryTool({ backend });
    await tool.forward({ op: "write", key: "a", value: "1" });
    await tool.forward({ op: "write", key: "b", value: "2" });
    const result = await tool.forward({ op: "list" });
    expect(result).toContain("a");
    expect(result).toContain("b");
  });

  it("list with prefix filters keys", async () => {
    const backend = new MapKvBackend();
    const tool = createMemoryTool({ backend });
    await tool.forward({ op: "write", key: "project:alpha", value: "1" });
    await tool.forward({ op: "write", key: "project:beta", value: "2" });
    await tool.forward({ op: "write", key: "other:thing", value: "3" });
    const result = await tool.forward({ op: "list", prefix: "project:" });
    expect(result).toContain("project:alpha");
    expect(result).toContain("project:beta");
    expect(result).not.toContain("other:");
  });

  it("delete removes a key", async () => {
    const backend = new MapKvBackend();
    const tool = createMemoryTool({ backend });
    await tool.forward({ op: "write", key: "temp", value: "data" });
    await tool.forward({ op: "delete", key: "temp" });
    const result = await tool.forward({ op: "read", key: "temp" });
    expect(result).toContain("no value");
  });

  it("cross-session simulation: second assembler reads memory from first", async () => {
    const backend = new MapKvBackend();
    const tool = createMemoryTool({ backend });

    // Session 1: write a fact.
    await tool.forward({ op: "write", key: "capital_france", value: "Paris" });

    // Session 2: new tool instance, same backend — read the fact.
    const tool2 = createMemoryTool({ backend });
    const value = await tool2.forward({ op: "read", key: "capital_france" });
    expect(value).toBe("Paris");
  });

  it("tool has correct readOnly and idempotent flags", () => {
    const backend = new MapKvBackend();
    const tool = createMemoryTool({ backend });
    expect(tool.readOnly).toBe(false);
    expect(tool.idempotent).toBe(false);
    expect(tool.name).toBe("memory");
  });

  it("needsApproval is set when requested", () => {
    const backend = new MapKvBackend();
    const tool = createMemoryTool({ backend, needsApproval: true });
    expect(tool.needsApproval).toBe(true);
  });

  it("needsApproval is not set by default", () => {
    const backend = new MapKvBackend();
    const tool = createMemoryTool({ backend });
    expect(tool.needsApproval).toBeUndefined();
  });
});

describe("MapKvBackend", () => {
  it("stores and retrieves values", async () => {
    const kv = new MapKvBackend();
    await kv.put("x", "hello");
    expect(await kv.get("x")).toBe("hello");
  });

  it("returns null for missing key", async () => {
    const kv = new MapKvBackend();
    expect(await kv.get("missing")).toBeNull();
  });

  it("delete removes a key", async () => {
    const kv = new MapKvBackend();
    await kv.put("y", "val");
    await kv.delete("y");
    expect(await kv.get("y")).toBeNull();
  });

  it("list returns keys matching prefix", async () => {
    const kv = new MapKvBackend();
    await kv.put("abc:1", "a");
    await kv.put("abc:2", "b");
    await kv.put("xyz:3", "c");
    const keys = await kv.list("abc:");
    expect(keys).toContain("abc:1");
    expect(keys).toContain("abc:2");
    expect(keys).not.toContain("xyz:3");
  });
});
