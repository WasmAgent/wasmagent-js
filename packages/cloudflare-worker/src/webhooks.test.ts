import { describe, expect, it, mock } from "bun:test";
import {
  buildEvidenceWebhookPayload,
  configFromEnv,
  evidenceConfigFromEnv,
  sendWebhook,
  type WebhookPayload,
} from "./webhooks.js";

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
    const fetcher = mock(async () => new Response("ok", { status: 200 }));
    const results = await sendWebhook(samplePayload, {
      config: { urls: ["https://a", "https://b"] },
      fetcher: fetcher as typeof fetch,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("retries on failure and reports final attempts", async () => {
    let calls = 0;
    const fetcher = mock(async () => {
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
    const fetcher = mock(async (url: string | Request, init?: RequestInit) => {
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
    const fetcher = mock(async () => new Response("nope", { status: 500 }));
    await sendWebhook(samplePayload, {
      config: { urls: ["https://x"], maxRetries: 2 },
      fetcher: fetcher as typeof fetch,
      dlqBackend,
    });
    const keys = [...dlqStore.keys()];
    expect(keys.length).toBe(1);
    const firstKey = keys[0];
    expect(firstKey).toMatch(/^dlq:r1:/);
    const raw = firstKey ? dlqStore.get(firstKey) : undefined;
    expect(raw).toBeDefined();
    const stored = JSON.parse(raw as string);
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

describe("evidenceConfigFromEnv", () => {
  it("returns null when no evidence urls", () => {
    expect(evidenceConfigFromEnv({})).toBeNull();
  });

  it("parses EVIDENCE_WEBHOOK_URLS independently from WEBHOOK_URLS", () => {
    const cfg = evidenceConfigFromEnv({ EVIDENCE_WEBHOOK_URLS: "https://audit1,https://audit2" });
    expect(cfg?.urls).toEqual(["https://audit1", "https://audit2"]);
  });

  it("includes the evidence-specific secret", () => {
    const cfg = evidenceConfigFromEnv({
      EVIDENCE_WEBHOOK_URLS: "https://audit",
      EVIDENCE_WEBHOOK_SECRET: "ev-secret",
    });
    expect(cfg?.secret).toBe("ev-secret");
  });
});

describe("buildEvidenceWebhookPayload", () => {
  const record = {
    schema_version: "aep/v0.3",
    run_id: "run-ev-1",
    model_id: "model-ev",
    created_at_ms: 1_700_000_000_000,
    actions: [],
  };

  it("builds an evidence.record payload with runId hoisted from the record", () => {
    const payload = buildEvidenceWebhookPayload(record);
    expect(payload.event).toBe("evidence.record");
    expect(payload.runId).toBe("run-ev-1");
    expect(payload.record).toBe(record);
    expect(payload.modelId).toBe("model-ev");
    expect(payload.createdAtMs).toBe(1_700_000_000_000);
    expect(payload.emittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("attaches stream metadata when provided", () => {
    const payload = buildEvidenceWebhookPayload(record, { sequence: 42, topic: "feed-1" });
    expect(payload.sequence).toBe(42);
    expect(payload.topic).toBe("feed-1");
  });

  it("omits optional fields when the record lacks them", () => {
    const minimal = { run_id: "run-only" };
    const payload = buildEvidenceWebhookPayload(minimal);
    expect(payload.runId).toBe("run-only");
    expect(payload.modelId).toBeUndefined();
    expect(payload.createdAtMs).toBeUndefined();
    expect(payload.sequence).toBeUndefined();
  });

  it("the resulting payload is deliverable by sendWebhook", async () => {
    const payload = buildEvidenceWebhookPayload(record, { sequence: 7, topic: "feed" });
    const fetcher = mock(async () => new Response("ok", { status: 200 }));
    const results = await sendWebhook(payload, {
      config: { urls: ["https://audit"] },
      fetcher: fetcher as typeof fetch,
    });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
