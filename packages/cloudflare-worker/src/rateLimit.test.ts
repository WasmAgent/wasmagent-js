import { describe, expect, it } from "vitest";
import { checkRateLimit, type RateLimitBackend, rateLimitedResponse } from "./rateLimit.js";

class MemBackend implements RateLimitBackend {
  readonly map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
}

describe("checkRateLimit", () => {
  it("allows the first request", async () => {
    const r = await checkRateLimit(new MemBackend(), "k", { rpm: 5 });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
  });

  it("rejects after rpm requests in the window", async () => {
    const b = new MemBackend();
    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit(b, "k", { rpm: 5 });
      expect(r.allowed).toBe(true);
    }
    const r6 = await checkRateLimit(b, "k", { rpm: 5 });
    expect(r6.allowed).toBe(false);
    expect(r6.remaining).toBe(0);
  });

  it("isolates limits by identity key", async () => {
    const b = new MemBackend();
    for (let i = 0; i < 5; i++) await checkRateLimit(b, "user-a", { rpm: 5 });
    const aFull = await checkRateLimit(b, "user-a", { rpm: 5 });
    expect(aFull.allowed).toBe(false);
    const bOk = await checkRateLimit(b, "user-b", { rpm: 5 });
    expect(bOk.allowed).toBe(true);
  });

  it("rolls over after the window expires", async () => {
    const b = new MemBackend();
    // simulate by manually inserting old timestamps
    const old = Date.now() - 70_000;
    await b.put("k", JSON.stringify([old, old + 1, old + 2]));
    const r = await checkRateLimit(b, "k", { rpm: 5 });
    // 3 old timestamps were pruned, so we're well under the limit
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
  });

  it("fails closed when KV value is malformed JSON", async () => {
    const b = new MemBackend();
    // A drive-by attacker (or storage corruption) writes garbage to the
    // limiter's key. Old behaviour silently reset to 0; we now refuse
    // requests for one window so the bypass attack fails.
    await b.put("k", "not-json{");
    const r = await checkRateLimit(b, "k", { rpm: 5 });
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it("fails closed when KV value is the wrong shape", async () => {
    const b = new MemBackend();
    await b.put("k", JSON.stringify({ not: "an array" }));
    const r = await checkRateLimit(b, "k", { rpm: 5 });
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });
});

describe("rateLimitedResponse", () => {
  it("returns 429 with Retry-After header", () => {
    const resp = rateLimitedResponse({
      allowed: false,
      remaining: 0,
      retryAtMs: Date.now() + 5_000,
    });
    expect(resp.status).toBe(429);
    const ra = Number(resp.headers.get("Retry-After"));
    expect(ra).toBeGreaterThan(0);
    expect(ra).toBeLessThanOrEqual(5);
  });
});
