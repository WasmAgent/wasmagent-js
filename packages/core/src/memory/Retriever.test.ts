import { describe, it, expect } from "vitest";
import { InMemoryVectorStore, makeRetrievalTool } from "./Retriever.js";

describe("InMemoryVectorStore", () => {
  it("stores and retrieves documents", async () => {
    const store = new InMemoryVectorStore();
    await store.add("doc1", "machine learning neural networks");
    await store.add("doc2", "cooking recipes pasta sauce");
    await store.add("doc3", "machine learning gradient descent");

    const results = await store.search("neural networks machine", 2);
    expect(results).toHaveLength(2);
    // doc1 and doc3 are about ML — should score higher than doc2
    const ids = results.map((r) => r.id);
    expect(ids).toContain("doc1");
  });

  it("returns empty results when store is empty", async () => {
    const store = new InMemoryVectorStore();
    const results = await store.search("anything");
    expect(results).toEqual([]);
  });

  it("respects topK limit", async () => {
    const store = new InMemoryVectorStore();
    await store.add("a", "cat animal");
    await store.add("b", "dog animal");
    await store.add("c", "fish animal");
    const results = await store.search("animal", 2);
    expect(results).toHaveLength(2);
  });

  it("scores are in descending order", async () => {
    const store = new InMemoryVectorStore();
    await store.add("x", "hello world foo bar");
    await store.add("y", "hello world");
    await store.add("z", "unrelated content here");

    const results = await store.search("hello world foo bar", 3);
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
    expect(results[1]!.score).toBeGreaterThanOrEqual(results[2]!.score);
  });

  it("stores metadata and returns it with results", async () => {
    const store = new InMemoryVectorStore();
    await store.add("doc1", "important document", { source: "wiki" });
    const results = await store.search("important", 1);
    expect(results[0]!.metadata?.["source"]).toBe("wiki");
  });

  it("size tracks number of entries", async () => {
    const store = new InMemoryVectorStore();
    expect(store.size).toBe(0);
    await store.add("a", "text a");
    await store.add("b", "text b");
    expect(store.size).toBe(2);
  });
});

describe("makeRetrievalTool", () => {
  it("returns a readOnly idempotent tool", () => {
    const store = new InMemoryVectorStore();
    const tool = makeRetrievalTool(store);
    expect(tool.readOnly).toBe(true);
    expect(tool.idempotent).toBe(true);
  });

  it("uses the provided name and description", () => {
    const store = new InMemoryVectorStore();
    const tool = makeRetrievalTool(store, { name: "my_retriever", description: "My desc" });
    expect(tool.name).toBe("my_retriever");
    expect(tool.description).toBe("My desc");
  });

  it("forwards search results", async () => {
    const store = new InMemoryVectorStore();
    await store.add("doc1", "climate change global warming");
    const tool = makeRetrievalTool(store);
    const result = await tool.forward({ query: "climate warming" });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]!.text).toBe("climate change global warming");
  });

  it("respects topK passed in input", async () => {
    const store = new InMemoryVectorStore();
    await store.add("a", "alpha beta gamma");
    await store.add("b", "alpha delta epsilon");
    await store.add("c", "unrelated zeta eta");
    const tool = makeRetrievalTool(store);
    const result = await tool.forward({ query: "alpha", topK: 1 });
    expect(result.results).toHaveLength(1);
  });
});
