import { Bm25Indexer, tokenize as bm25Tokenize } from "./Bm25Indexer.js";

describe("bm25Tokenize", () => {
  it("lowercases ASCII words", () => {
    expect(bm25Tokenize("Hello World")).toEqual(["hello", "world"]);
  });

  it("tokenizes Chinese characters individually", () => {
    expect(bm25Tokenize("你好 世界")).toEqual(["你", "好", "世", "界"]);
  });

  it("strips punctuation", () => {
    expect(bm25Tokenize("foo, bar! baz?")).toEqual(["foo", "bar", "baz"]);
  });

  it("handles empty input", () => {
    expect(bm25Tokenize("")).toEqual([]);
  });
});

describe("Bm25Indexer", () => {
  it("returns empty for empty index", () => {
    const idx = new Bm25Indexer();
    expect(idx.search("anything")).toEqual([]);
  });

  it("ranks the document containing the query token highest", () => {
    const idx = new Bm25Indexer();
    idx.index("d1", "the quick brown fox jumps over the lazy dog");
    idx.index("d2", "wasmagent is a typescript agent runtime built on wasm");
    idx.index("d3", "the lazy dog naps under the tree");

    const top = idx.search("lazy dog", 5);
    expect(top.length).toBeGreaterThan(0);
    // d1 and d3 both contain "lazy" + "dog"; one of them must be #1
    expect(["d1", "d3"]).toContain(top[0]?.id);
  });

  it("higher term frequency in shorter doc wins (BM25 norm)", () => {
    const idx = new Bm25Indexer();
    idx.index("short", "agent agent");
    idx.index("long", "agent the the the the the the the the the the the the");
    const top = idx.search("agent", 5);
    expect(top[0]?.id).toBe("short");
  });

  it("re-indexing a doc updates DF correctly", () => {
    const idx = new Bm25Indexer();
    idx.index("d1", "alpha beta");
    idx.index("d1", "gamma delta"); // overwrite — alpha/beta should no longer be findable for d1
    const r = idx.search("alpha");
    expect(r.find((x) => x.id === "d1")).toBeUndefined();
    const r2 = idx.search("gamma");
    expect(r2[0]?.id).toBe("d1");
  });

  it("remove() drops a doc from the index", () => {
    const idx = new Bm25Indexer();
    idx.index("d1", "alpha");
    idx.index("d2", "alpha");
    expect(idx.size()).toBe(2);
    expect(idx.remove("d1")).toBe(true);
    expect(idx.size()).toBe(1);
    const r = idx.search("alpha");
    expect(r.map((x) => x.id)).toEqual(["d2"]);
  });

  it("preserves metadata across search", () => {
    const idx = new Bm25Indexer();
    idx.index("d1", "alpha", { src: "test" });
    const top = idx.search("alpha", 1);
    expect(top[0]?.metadata).toEqual({ src: "test" });
  });

  it("returns empty when query has no tokens", () => {
    const idx = new Bm25Indexer();
    idx.index("d1", "hello");
    expect(idx.search("???")).toEqual([]);
  });

  it("topK limits results", () => {
    const idx = new Bm25Indexer();
    for (let i = 0; i < 10; i++) idx.index(`d${i}`, "alpha");
    expect(idx.search("alpha", 3)).toHaveLength(3);
  });
});
