import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { braveSearchTool, LruCache, perplexityAskTool, tavilySearchTool } from "./index.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("LruCache", () => {
  it("returns undefined for missing keys", () => {
    const c = new LruCache<string, string>(2);
    expect(c.get("x")).toBeUndefined();
  });

  it("set + get round-trip", () => {
    const c = new LruCache<string, string>(2);
    c.set("a", "1");
    expect(c.get("a")).toBe("1");
  });

  it("expires entries after ttl", async () => {
    const c = new LruCache<string, string>(4);
    c.set("a", "1", 5);
    expect(c.get("a")).toBe("1");
    await new Promise((r) => setTimeout(r, 15));
    expect(c.get("a")).toBeUndefined();
  });

  it("evicts least-recently-used when over max", () => {
    const c = new LruCache<string, number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
    expect(c.get("c")).toBe(3);
  });
});

describe("tavilySearchTool", () => {
  it("calls Tavily endpoint with the query and api key", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            {
              title: "T",
              url: "https://x",
              content: "C",
              score: 0.9,
              published_date: "2026-01-01",
            },
          ],
        }),
        { status: 200 }
      )
    );

    const tool = tavilySearchTool({ apiKey: "tvly-test", maxResults: 3 });
    const out = await tool.forward({ query: "react 19" }, {} as never);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] =
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(url).toBe("https://api.tavily.com/search");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.api_key).toBe("tvly-test");
    expect(body.query).toBe("react 19");
    expect(body.max_results).toBe(3);
    expect(out).toEqual([
      { title: "T", url: "https://x", snippet: "C", score: 0.9, publishedAt: "2026-01-01" },
    ]);
  });

  it("caches identical queries within TTL", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ title: "A", url: "u", content: "c" }] }), {
        status: 200,
      })
    );
    const tool = tavilySearchTool({ apiKey: "k", cacheTtlMs: 60_000 });
    await tool.forward({ query: "same" }, {} as never);
    await tool.forward({ query: "same" }, {} as never);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("throws on non-2xx", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("rate limited", { status: 429 })
    );
    const tool = tavilySearchTool({ apiKey: "k" });
    await expect(tool.forward({ query: "x" }, {} as never)).rejects.toThrow(/HTTP 429/);
  });

  it("declares readOnly + idempotent for DAG scheduling", () => {
    const tool = tavilySearchTool({ apiKey: "k" });
    expect(tool.readOnly).toBe(true);
    expect(tool.idempotent).toBe(true);
  });
});

describe("braveSearchTool", () => {
  it("uses X-Subscription-Token header and limits count", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          web: {
            results: [
              { title: "B1", url: "https://b1", description: "d1", age: "2 days ago" },
              { title: "B2", url: "https://b2", description: "d2" },
            ],
          },
        }),
        { status: 200 }
      )
    );

    const tool = braveSearchTool({ apiKey: "brv-key", maxResults: 5 });
    const out = await tool.forward({ query: "deno" }, {} as never);

    const [url, init] =
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(String(url)).toContain("api.search.brave.com");
    expect(String(url)).toContain("q=deno");
    expect((init as RequestInit).headers).toMatchObject({ "X-Subscription-Token": "brv-key" });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      title: "B1",
      url: "https://b1",
      snippet: "d1",
      publishedAt: "2 days ago",
    });
  });

  it("respects maxResults truncation", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          web: {
            results: Array.from({ length: 10 }, (_, i) => ({
              title: `T${i}`,
              url: `https://x/${i}`,
              description: "d",
            })),
          },
        }),
        { status: 200 }
      )
    );
    const tool = braveSearchTool({ apiKey: "k", maxResults: 3 });
    const out = await tool.forward({ query: "q" }, {} as never);
    expect(out).toHaveLength(3);
  });
});

describe("perplexityAskTool", () => {
  it("calls Perplexity chat completions and returns answer + citations", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Answer with [1] cite." } }],
          citations: ["https://src1"],
        }),
        { status: 200 }
      )
    );

    const tool = perplexityAskTool({ apiKey: "pplx-key", model: "sonar" });
    const out = await tool.forward({ query: "Why is the sky blue?" }, {} as never);

    const [url, init] =
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(url).toBe("https://api.perplexity.ai/chat/completions");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer pplx-key" });
    expect(out.answer).toContain("[1]");
    expect(out.citations).toEqual(["https://src1"]);
  });

  it("returns empty answer when API gives no choices", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 })
    );
    const tool = perplexityAskTool({ apiKey: "k" });
    const out = await tool.forward({ query: "x" }, {} as never);
    expect(out.answer).toBe("");
    expect(out.citations).toEqual([]);
  });
});

describe("provider tools share common SearchResult shape", () => {
  it("tavily and brave outputs are structurally compatible", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ title: "T", url: "u", content: "c" }] }), {
        status: 200,
      })
    );
    const tav = tavilySearchTool({ apiKey: "k" });
    const tavOut = await tav.forward({ query: "q" }, {} as never);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ web: { results: [{ title: "B", url: "u", description: "d" }] } }),
        {
          status: 200,
        }
      )
    );
    const brv = braveSearchTool({ apiKey: "k" });
    const brvOut = await brv.forward({ query: "q" }, {} as never);

    for (const r of [...tavOut, ...brvOut]) {
      expect(typeof r.title).toBe("string");
      expect(typeof r.url).toBe("string");
      expect(typeof r.snippet).toBe("string");
    }
  });
});
