import { HybridRetriever, hybridRetriever } from "./HybridRetriever.js";
import type { Retriever, SearchResult } from "./Retriever.js";

class FakeDense implements Retriever {
  readonly #docs = new Map<string, { text: string; metadata?: Record<string, unknown> }>();

  async add(id: string, text: string, metadata?: Record<string, unknown>): Promise<void> {
    this.#docs.set(id, metadata !== undefined ? { text, metadata } : { text });
  }

  async search(query: string, topK = 5): Promise<SearchResult[]> {
    // Simulate "semantic" search by counting char overlap. Crude but
    // deterministic enough for tests.
    const overlap = (a: string, b: string) =>
      [...a.toLowerCase()].filter((c) => b.toLowerCase().includes(c)).length;
    const out: SearchResult[] = [];
    for (const [id, { text, metadata }] of this.#docs.entries()) {
      const score = overlap(query, text) / Math.max(text.length, 1);
      const sr: SearchResult = { id, text, score };
      if (metadata !== undefined) sr.metadata = metadata;
      out.push(sr);
    }
    return out.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}

describe("HybridRetriever", () => {
  it("returns dense + bm25 fused results", async () => {
    const dense = new FakeDense();
    const hybrid = new HybridRetriever({ dense });

    await hybrid.add("d1", "wasmagent is a typescript agent runtime");
    await hybrid.add("d2", "react 19 introduced the use hook");
    await hybrid.add("d3", "the quick brown fox jumps over the lazy dog");

    const out = await hybrid.search("wasmagent typescript runtime", 3);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.id).toBe("d1");
  });

  it("empty index returns empty results", async () => {
    const hybrid = new HybridRetriever({ dense: new FakeDense() });
    expect(await hybrid.search("anything")).toEqual([]);
  });

  it("uses both BM25 and dense — purely-dense miss can still surface via BM25", async () => {
    const dense = new FakeDense();
    // FakeDense scores by char overlap, so this query might miss "react".
    // But BM25 has a clean keyword hit.
    const hybrid = new HybridRetriever({ dense, bm25Weight: 0.9, semanticWeight: 0.1 });
    await hybrid.add("d1", "react 19 introduces the use hook");
    await hybrid.add("d2", "lorem ipsum dolor sit amet");

    const out = await hybrid.search("react use hook", 2);
    expect(out[0]?.id).toBe("d1");
  });

  it("hybridRetriever() factory matches new HybridRetriever()", async () => {
    const a = new HybridRetriever({ dense: new FakeDense() });
    const b = hybridRetriever({ dense: new FakeDense() });
    expect(a.constructor.name).toBe(b.constructor.name);
  });

  it("respects topK on the fused result list", async () => {
    const hybrid = new HybridRetriever({ dense: new FakeDense() });
    for (let i = 0; i < 10; i++) await hybrid.add(`d${i}`, `agent agent ${i}`);
    const out = await hybrid.search("agent", 3);
    expect(out).toHaveLength(3);
  });

  it("preserves metadata through fusion", async () => {
    const hybrid = new HybridRetriever({ dense: new FakeDense() });
    await hybrid.add("d1", "agent runtime", { src: "test" });
    const out = await hybrid.search("agent", 1);
    expect(out[0]?.metadata).toEqual({ src: "test" });
  });
});
