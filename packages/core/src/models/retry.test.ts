import { describe, it, expect, vi } from "vitest";
import { withRetry, withRetryGenerator } from "../models/retry.js";

// ── withRetry ────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  it("returns result immediately on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and succeeds on 3rd attempt (C1)", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) {
        const err = new Error("Rate limited") as Error & { status: number };
        err.status = 429;
        throw err;
      }
      return "success";
    });
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 0 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries on 503 server error (C1)", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 2) {
        const err = new Error("Server error") as Error & { status: number };
        err.status = 503;
        throw err;
      }
      return "ok";
    });
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 400 bad request (C1 — non-retryable 4xx)", async () => {
    const fn = vi.fn().mockImplementation(async () => {
      const err = new Error("Bad request") as Error & { status: number };
      err.status = 400;
      throw err;
    });
    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 0 })).rejects.toMatchObject({
      status: 400,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 401 unauthorized (C1 — non-retryable 4xx)", async () => {
    const fn = vi.fn().mockImplementation(async () => {
      const err = new Error("Unauthorized") as Error & { status: number };
      err.status = 401;
      throw err;
    });
    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 0 })).rejects.toMatchObject({
      status: 401,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("exhausts retries and re-throws the last error", async () => {
    const fn = vi.fn().mockImplementation(async () => {
      const err = new Error("429") as Error & { status: number };
      err.status = 429;
      throw err;
    });
    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 0 })).rejects.toMatchObject({
      status: 429,
    });
    expect(fn).toHaveBeenCalledTimes(3); // 1 original + 2 retries
  });

  it("respects Retry-After header to compute delay (C1)", async () => {
    const delays: number[] = [];
    const origSetTimeout = setTimeout;
    vi.spyOn(global, "setTimeout").mockImplementation((fn, ms) => {
      delays.push(ms as number);
      return origSetTimeout(fn, 0);
    });

    let calls = 0;
    const err429 = new Error("429") as Error & { status: number; headers: Record<string, string> };
    err429.status = 429;
    err429.headers = { "retry-after": "2" }; // 2 seconds

    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 2) throw err429;
      return "ok";
    });

    await withRetry(fn, { maxRetries: 3, baseDelayMs: 0 });
    // The delay should be ~2000ms (2s from Retry-After), with ±20% jitter
    expect(delays[0]).toBeGreaterThanOrEqual(1600);
    expect(delays[0]).toBeLessThanOrEqual(2401);
    vi.restoreAllMocks();
  });

  it("retries on network error (no status property) (C1)", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 2) throw new Error("ECONNRESET");
      return "ok";
    });
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ── withRetryGenerator ───────────────────────────────────────────────────────

describe("withRetryGenerator", () => {
  it("yields all values on first success", async () => {
    async function* gen() { yield 1; yield 2; yield 3; }
    const results: number[] = [];
    for await (const v of withRetryGenerator(gen, { maxRetries: 3, baseDelayMs: 0 })) {
      results.push(v);
    }
    expect(results).toEqual([1, 2, 3]);
  });

  it("retries generator on 429 and yields values on success", async () => {
    let attempt = 0;
    async function* gen() {
      attempt++;
      if (attempt < 2) {
        const err = new Error("429") as Error & { status: number };
        err.status = 429;
        throw err;
      }
      yield "ok";
    }
    const results: string[] = [];
    for await (const v of withRetryGenerator(gen, { maxRetries: 3, baseDelayMs: 0 })) {
      results.push(v);
    }
    expect(results).toEqual(["ok"]);
    expect(attempt).toBe(2);
  });
});
