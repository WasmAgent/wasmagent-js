import { describe, expect, it, vi } from "vitest";
import { configFromEnv, sendWebhook, type WebhookPayload } from "./webhooks.js";

const samplePayload: WebhookPayload = {
  event: "run.completed",
  runId: "r1",
  userId: "u1",
  task: "test",
  answer: "yes",
  emittedAt: "2026-06-10T00:00:00Z",
};

describe("sendWebhook", () => {
  it("sends to all configured URLs", async () => {
    const fetcher = vi.fn(async () => new Response("ok", { status: 200 }));
    const results = await sendWebhook(samplePayload, {
      config: { urls: ["https://a", "https://b"] },
      fetcher: fetcher as typeof fetch,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("retries on failure and reports final attempts", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      return new Response("nope", { status: 500 });
    });
    const results = await sendWebhook(samplePayload, {
      config: { urls: ["https://x"], maxRetries: 3 },
      fetcher: fetcher as typeof fetch,
    });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it("signs the payload with HMAC when secret is configured", async () => {
    const calls: { url: string; signature: string | null; body: string }[] = [];
    const fetcher = vi.fn(async (url: string | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const signature = headers?.["X-Agentkit-Signature"] ?? null;
      calls.push({ url: String(url), signature, body: init?.body as string });
      return new Response("ok", { status: 200 });
    });
    await sendWebhook(samplePayload, {
      config: { urls: ["https://x"], secret: "secret-1" },
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(calls[0]?.signature).toMatch(/^sha256=[a-f0-9]+$/);
  });

  it("writes failed deliveries to DLQ backend", async () => {
    const dlqStore = new Map<string, string>();
    const dlqBackend = { put: async (k: string, v: string) => void dlqStore.set(k, v) };
    const fetcher = vi.fn(async () => new Response("nope", { status: 500 }));
    await sendWebhook(samplePayload, {
      config: { urls: ["https://x"], maxRetries: 2 },
      fetcher: fetcher as typeof fetch,
      dlqBackend,
    });
    const keys = [...dlqStore.keys()];
    expect(keys.length).toBe(1);
    expect(keys[0]).toMatch(/^dlq:r1:/);
    const stored = JSON.parse(dlqStore.get(keys[0]!)!);
    expect(stored.lastStatus).toBe(500);
  });
});

describe("configFromEnv", () => {
  it("returns null when no urls", () => {
    expect(configFromEnv({})).toBeNull();
  });

  it("parses comma-separated urls", () => {
    const cfg = configFromEnv({ WEBHOOK_URLS: "https://a,https://b" });
    expect(cfg?.urls).toEqual(["https://a", "https://b"]);
  });

  it("includes secret when present", () => {
    const cfg = configFromEnv({ WEBHOOK_URLS: "https://a", WEBHOOK_SECRET: "k" });
    expect(cfg?.secret).toBe("k");
  });
});
