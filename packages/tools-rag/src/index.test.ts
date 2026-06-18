import type { Embedder, Retriever, SearchResult } from "@wasmagent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HttpEmbedder,
  PineconeStore,
  pineconeStore,
  QdrantStore,
  qdrantStore,
  ragTool,
} from "./index.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const mockFetch = () => globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

// ── HttpEmbedder ──────────────────────────────────────────────────────────────

describe("HttpEmbedder", () => {
  it("calls OpenAI-compatible /v1/embeddings by default", async () => {
    mockFetch().mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 })
    );
    const embedder = new HttpEmbedder({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
    });
    const v = await embedder.embed("hello");
    expect(v).toEqual([0.1, 0.2, 0.3]);

    const [url, init] = mockFetch().mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.openai.com/v1/embeddings");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk-test" });
  });

  it("supports custom baseUrl + path (e.g. local Ollama)", async () => {
    mockFetch().mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 })
    );
    const embedder = new HttpEmbedder({
      apiKey: "local",
      model: "nomic-embed-text",
      baseUrl: "http://localhost:11434",
      path: "/v1/embeddings",
    });
    await embedder.embed("hi");
    const [url] = mockFetch().mock.calls[0] ?? [];
    expect(String(url)).toBe("http://localhost:11434/v1/embeddings");
  });

  it("embedBatch returns vectors for each input", async () => {
    mockFetch().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ embedding: [1, 0] }, { embedding: [0, 1] }],
        }),
        { status: 200 }
      )
    );
    const embedder = new HttpEmbedder({ apiKey: "k", model: "m" });
    const out = await embedder.embedBatch(["a", "b"]);
    expect(out).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it("supports custom buildRequest + parseResponse for non-OpenAI APIs", async () => {
    mockFetch().mockResolvedValueOnce(
      new Response(JSON.stringify({ embeddings: [[1, 2]] }), { status: 200 })
    );
    const embedder = new HttpEmbedder({
      apiKey: "k",
      model: "voyage-3",
      buildRequest: (input, model) => ({ input, model, input_type: "document" }),
      parseResponse: (data: unknown) => (data as { embeddings: number[][] }).embeddings,
    });
    const v = await embedder.embed("test");
    expect(v).toEqual([1, 2]);
  });

  it("throws on non-2xx", async () => {
    mockFetch().mockResolvedValueOnce(new Response("bad", { status: 401 }));
    const embedder = new HttpEmbedder({ apiKey: "k", model: "m" });
    await expect(embedder.embed("x")).rejects.toThrow(/HTTP 401/);
  });
});

// ── ragTool ──────────────────────────────────────────────────────────────────

describe("ragTool", () => {
  const fakeStore: Retriever = {
    add: async () => {},
    search: async (query: string, topK?: number): Promise<SearchResult[]> => {
      return [
        { id: "doc-1", text: `match for ${query}`, score: 0.95 },
        { id: "doc-2", text: "weak match", score: 0.3 },
      ].slice(0, topK ?? 5);
    },
  };

  it("returns ranked chunks from the underlying store", async () => {
    const tool = ragTool({ store: fakeStore });
    const out = await tool.forward({ query: "agentkit" }, {} as never);
    expect(out).toHaveLength(2);
    expect(out[0]?.id).toBe("doc-1");
  });

  it("respects topK at call time", async () => {
    const tool = ragTool({ store: fakeStore });
    const out = await tool.forward({ query: "x", topK: 1 }, {} as never);
    expect(out).toHaveLength(1);
  });

  it("filters by minScore when configured", async () => {
    const tool = ragTool({ store: fakeStore, minScore: 0.5 });
    const out = await tool.forward({ query: "x" }, {} as never);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("doc-1");
  });

  it("declares readOnly + idempotent", () => {
    const tool = ragTool({ store: fakeStore });
    expect(tool.readOnly).toBe(true);
    expect(tool.idempotent).toBe(true);
  });

  it("supports custom name + description for multi-RAG agents", () => {
    const tool = ragTool({
      store: fakeStore,
      name: "retrieve_docs",
      description: "Search internal documentation.",
    });
    expect(tool.name).toBe("retrieve_docs");
    expect(tool.description).toContain("documentation");
  });
});

// ── PineconeStore ─────────────────────────────────────────────────────────────

describe("PineconeStore", () => {
  const fakeEmbedder: Embedder = { embed: async () => [1, 2, 3] };

  it("uploads vector to /vectors/upsert with namespace", async () => {
    mockFetch().mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const store = pineconeStore({
      apiKey: "pc-key",
      indexHost: "https://idx.svc.us-east-1.pinecone.io",
      namespace: "ns-1",
      embedder: fakeEmbedder,
    });
    await store.add("doc-1", "hello", { src: "test" });

    const [url, init] = mockFetch().mock.calls[0] ?? [];
    expect(String(url)).toBe("https://idx.svc.us-east-1.pinecone.io/vectors/upsert");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.namespace).toBe("ns-1");
    expect(body.vectors[0]).toMatchObject({
      id: "doc-1",
      values: [1, 2, 3],
      metadata: { src: "test", __text: "hello" },
    });
  });

  it("queries with includeMetadata=true and parses matches", async () => {
    mockFetch().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          matches: [
            { id: "m1", score: 0.99, metadata: { __text: "matched", src: "a" } },
            { id: "m2", score: 0.5, metadata: { __text: "less", src: "b" } },
          ],
        }),
        { status: 200 }
      )
    );
    const store = new PineconeStore({
      apiKey: "k",
      indexHost: "https://idx",
      embedder: fakeEmbedder,
    });
    const out = await store.search("q");
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: "m1",
      text: "matched",
      score: 0.99,
      metadata: { src: "a" },
    });
  });
});

// ── QdrantStore ───────────────────────────────────────────────────────────────

describe("QdrantStore", () => {
  const fakeEmbedder: Embedder = { embed: async () => [0.1, 0.2] };

  it("upserts points to /collections/<name>/points", async () => {
    mockFetch().mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const store = qdrantStore({
      url: "http://localhost:6333",
      collection: "docs",
      embedder: fakeEmbedder,
    });
    await store.add("p1", "text-a", { kind: "note" });

    const [url, init] = mockFetch().mock.calls[0] ?? [];
    expect(String(url)).toBe("http://localhost:6333/collections/docs/points?wait=true");
    expect((init as RequestInit).method).toBe("PUT");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.points[0]).toMatchObject({
      id: "p1",
      vector: [0.1, 0.2],
      payload: { kind: "note", __text: "text-a" },
    });
  });

  it("searches and parses results, stripping __text from metadata", async () => {
    mockFetch().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: [{ id: 42, score: 0.88, payload: { __text: "found it", kind: "note" } }],
        }),
        { status: 200 }
      )
    );
    const store = new QdrantStore({
      url: "http://localhost:6333",
      collection: "docs",
      embedder: fakeEmbedder,
    });
    const out = await store.search("q");
    expect(out).toEqual([{ id: "42", text: "found it", score: 0.88, metadata: { kind: "note" } }]);
  });

  it("attaches api-key header when provided", async () => {
    mockFetch().mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const store = new QdrantStore({
      url: "https://qdrant.cloud",
      apiKey: "qd-key",
      collection: "c",
      embedder: fakeEmbedder,
    });
    await store.add("p1", "t");
    const [, init] = mockFetch().mock.calls[0] ?? [];
    expect((init as RequestInit).headers).toMatchObject({ "api-key": "qd-key" });
  });
});

// ── Generic-foundation guard ─────────────────────────────────────────────────

describe("generic-foundation principle", () => {
  it("no source file references a specific product", async () => {
    // Static check: read this test file's siblings via import. If any
    // bscode-related token sneaks in, this fails.
    const sources = [
      (await import("./HttpEmbedder.js")).HttpEmbedder.toString(),
      (await import("./RagTool.js")).ragTool.toString(),
      (await import("./connectors/pinecone.js")).PineconeStore.toString(),
      (await import("./connectors/qdrant.js")).QdrantStore.toString(),
    ].join("\n");

    expect(sources).not.toMatch(/bscode/i);
    expect(sources).not.toContain("BSCode");
    expect(sources).not.toContain("WebContainers");
  });
});
