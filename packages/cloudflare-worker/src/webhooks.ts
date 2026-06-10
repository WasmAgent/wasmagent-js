/**
 * Webhook delivery for the agentkit-js Cloudflare Worker.
 *
 * Posts run-completion (and optionally other lifecycle events) to one
 * or more configured URLs. Optionally signs the payload with HMAC-SHA-
 * 256 so the receiver can verify integrity.
 *
 * Failures are retried with exponential backoff up to N times. After
 * the final attempt, the payload + last error are pushed to a KV-backed
 * dead-letter queue (the caller must wire that up via {@link sendWebhook}'s
 * `dlqBackend` param).
 */

export type WebhookEvent = "run.completed" | "run.failed" | "run.cancelled" | "run.awaiting_input";

export interface WebhookPayload {
  event: WebhookEvent;
  runId: string;
  userId?: string;
  task?: string;
  answer?: string;
  error?: string;
  tokenUsage?: { input: number; output: number };
  costUsd?: number;
  durationMs?: number;
  /** ISO timestamp at delivery time. */
  emittedAt: string;
  /** Free-form. */
  [k: string]: unknown;
}

export interface WebhookConfig {
  /** Comma-separated URL list. */
  urls: string[];
  /** Optional HMAC signing secret. When set, payload is signed via
   *  HMAC-SHA-256 and the digest is sent as `X-Agentkit-Signature: sha256=<hex>`. */
  secret?: string;
  /** Max retry attempts (default 3). */
  maxRetries?: number;
}

export interface DeadLetterBackend {
  put(key: string, value: string): Promise<void>;
}

export interface SendWebhookOpts {
  config: WebhookConfig;
  /** When provided, failed deliveries are written to this backend after retries are exhausted. */
  dlqBackend?: DeadLetterBackend;
  /** Override fetch (for tests). */
  fetcher?: typeof fetch;
}

const HMAC_HEADER = "X-Agentkit-Signature";

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  // Convert to hex
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `sha256=${hex}`;
}

async function deliverOnce(
  url: string,
  body: string,
  secret: string | undefined,
  fetcher: typeof fetch
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers[HMAC_HEADER] = await sign(secret, body);
  return fetcher(url, { method: "POST", headers, body });
}

export interface DeliveryResult {
  url: string;
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

/**
 * Deliver a webhook payload to all configured URLs. Returns the
 * per-URL delivery result. Caller decides how to act on failure
 * (logging, alerting, DLQ). When `dlqBackend` is provided, failed
 * deliveries are persisted with key `dlq:<runId>:<url-hash>`.
 */
export async function sendWebhook(
  payload: WebhookPayload,
  opts: SendWebhookOpts
): Promise<DeliveryResult[]> {
  const fetcher = opts.fetcher ?? fetch;
  const maxRetries = opts.config.maxRetries ?? 3;
  const body = JSON.stringify(payload);
  const results: DeliveryResult[] = [];

  for (const url of opts.config.urls) {
    let attempts = 0;
    let lastError: string | undefined;
    let lastStatus: number | undefined;

    while (attempts < maxRetries) {
      attempts++;
      try {
        const resp = await deliverOnce(url, body, opts.config.secret, fetcher);
        if (resp.ok) {
          results.push({ url, ok: true, attempts, status: resp.status });
          break;
        }
        lastStatus = resp.status;
        lastError = `HTTP ${resp.status}`;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
      // Exponential backoff: 200ms, 400ms, 800ms...
      if (attempts < maxRetries) {
        await new Promise((r) => setTimeout(r, 200 * 2 ** (attempts - 1)));
      }
    }

    if (attempts >= maxRetries) {
      const result: DeliveryResult = { url, ok: false, attempts };
      if (lastStatus !== undefined) result.status = lastStatus;
      if (lastError !== undefined) result.error = lastError;
      results.push(result);
      if (opts.dlqBackend) {
        const urlHash = await hashShort(url);
        await opts.dlqBackend.put(
          `dlq:${payload.runId}:${urlHash}`,
          JSON.stringify({ payload, lastError, lastStatus, attempts })
        );
      }
    }
  }

  return results;
}

async function hashShort(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(buf).slice(0, 6);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Parse a comma-separated URL env var into a config. */
export function configFromEnv(env: {
  WEBHOOK_URLS?: string;
  WEBHOOK_SECRET?: string;
}): WebhookConfig | null {
  const urls = (env.WEBHOOK_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (urls.length === 0) return null;
  const cfg: WebhookConfig = { urls };
  if (env.WEBHOOK_SECRET) cfg.secret = env.WEBHOOK_SECRET;
  return cfg;
}
