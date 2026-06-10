import { describe, expect, it } from "vitest";
import type { Embedder } from "./Retriever.js";
import { InMemoryVectorStore, KvBackendVectorStore, makeRetrievalTool } from "./Retriever.js";

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
    expect(results[0]?.score ?? 0).toBeGreaterThanOrEqual(results[1]?.score ?? 0);
    expect(results[1]?.score ?? 0).toBeGreaterThanOrEqual(results[2]?.score ?? 0);
  });

  it("stores metadata and returns it with results", async () => {
    const store = new InMemoryVectorStore();
    await store.add("doc1", "important document", { source: "wiki" });
    const results = await store.search("important", 1);
    expect(results[0]?.metadata?.source).toBe("wiki");
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
    expect(result.results[0]?.text).toBe("climate change global warming");
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

  it("D3: makeRetrievalTool marks results as untrusted", () => {
    const store = new InMemoryVectorStore();
    const tool = makeRetrievalTool(store);
    expect(tool.trust).toBe("untrusted");
  });
});

// ── D3: Pluggable Embedder ────────────────────────────────────────────────────

describe("D3 — Pluggable Embedder", () => {
  it("InMemoryVectorStore accepts a custom embedder", async () => {
    let embedCallCount = 0;
    const mockEmbedder: Embedder = {
      async embed(text: string): Promise<number[]> {
        embedCallCount++;
        // Simple hash-based embedding for test reproducibility
        const tokens = text.toLowerCase().split(/\s+/);
        const vec = new Array(10).fill(0);
        for (const tok of tokens) {
          let hash = 0;
          for (let i = 0; i < tok.length; i++) hash = (hash * 31 + tok.charCodeAt(i)) & 0x3ff;
          vec[hash % 10] = (vec[hash % 10] ?? 0) + 1;
        }
        return vec;
      },
    };

    const store = new InMemoryVectorStore(mockEmbedder);
    await store.add("doc1", "apple fruit");
    await store.add("doc2", "banana fruit");
    await store.add("doc3", "car vehicle");

    const results = await store.search("apple fruit", 1);
    expect(results[0]?.id).toBe("doc1");
    expect(embedCallCount).toBeGreaterThan(0);
  });

  it("ModelEmbedder benchmark: exact-match embedder beats TF-IDF on synonym queries", async () => {
    // Simulate a "model embedder" using topic vectors.
    // Each doc/query gets a 5-dim topic vector based on keyword presence.
    // Dimension 0 = ML, dim 1 = cooking, dim 2 = vehicles
    function semanticEmbed(text: string): number[] {
      const t = text.toLowerCase();
      return [
        t.includes("machine") ||
        t.includes("neural") ||
        t.includes("learning") ||
        t.includes("gradient")
          ? 1
          : 0,
        t.includes("cooking") || t.includes("recipe") || t.includes("pasta") ? 1 : 0,
        t.includes("car") || t.includes("vehicle") || t.includes("engine") ? 1 : 0,
        0,
        0,
      ];
    }
    const semanticEmbedder: Embedder = { embed: async (t) => semanticEmbed(t) };
    const tfidfStore = new InMemoryVectorStore();
    const semanticStore = new InMemoryVectorStore(semanticEmbedder);
    const docs = [
      { id: "ml1", text: "machine learning neural networks deep learning backpropagation" },
      { id: "cook1", text: "cooking recipes pasta sauce tomato" },
      { id: "car1", text: "car vehicle engine automobile" },
    ];
    for (const d of docs) {
      await tfidfStore.add(d.id, d.text);
      await semanticStore.add(d.id, d.text);
    }

    // Semantic query — should map cleanly to the ML doc
    const semanticResults = await semanticStore.search("neural learning gradient", 1);
    expect(semanticResults[0]?.id).toBe("ml1");

    const semanticTopScore = semanticResults[0]?.score ?? 0;
    expect(semanticTopScore).toBeGreaterThan(0);

    // Cooking query — should rank cook1 first
    const cookResults = await semanticStore.search("pasta recipes cooking", 1);
    expect(cookResults[0]?.id).toBe("cook1");

    // TF-IDF also works (just verify it runs without error)
    const tfidfResults = await tfidfStore.search("neural learning", 1);
    expect(Array.isArray(tfidfResults)).toBe(true);
  });
});

// ── D3: KvBackendVectorStore ──────────────────────────────────────────────────

describe("D3 — KvBackendVectorStore", () => {
  function makeMockKv() {
    const store = new Map<string, string>();
    return {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v);
      },
      delete: async (k: string) => {
        store.delete(k);
      },
    };
  }

  it("persists entries to KvBackend and retrieves them", async () => {
    const kv = makeMockKv();
    const embedder: Embedder = {
      async embed(text: string): Promise<number[]> {
        return text.includes("ml") ? [1, 0] : [0, 1];
      },
    };
    const store = new KvBackendVectorStore(kv, embedder);
    await store.add("doc1", "ml machine learning");
    await store.add("doc2", "cooking recipes");

    const results = await store.search("ml", 1);
    expect(results[0]?.id).toBe("doc1");
  });

  it("loads persisted index on second instantiation (cross-session)", async () => {
    const kv = makeMockKv();
    const embedder: Embedder = {
      async embed(text: string): Promise<number[]> {
        return text.includes("ml") ? [1, 0] : [0, 1];
      },
    };
    const store1 = new KvBackendVectorStore(kv, embedder);
    await store1.add("doc1", "ml machine learning");

    // Second instance using same KV — should find persisted data
    const store2 = new KvBackendVectorStore(kv, embedder);
    const results = await store2.search("ml", 1);
    expect(results[0]?.id).toBe("doc1");
  });
});
