/**
 * Exponential backoff retry for model API calls (C1).
 *
 * Retries on: 429 (rate-limit), 5xx (server errors), network errors.
 * Does NOT retry: 4xx other than 429 (auth failures, bad requests).
 *
 * Respects the `Retry-After` header when present.
 */

export interface RetryPolicy {
  /** Maximum number of retry attempts. Default: 3. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 500. */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. Default: 30_000. */
  maxDelayMs?: number;
}

const DEFAULT_POLICY: Required<RetryPolicy> = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    // Network-level errors (no status): ECONNRESET, ENOTFOUND, fetch failures.
    if (!("status" in err)) return true;
    const status = (err as { status: number }).status;
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  return false;
}

function retryAfterMs(err: unknown): number | null {
  if (err instanceof Error && "headers" in err) {
    const headers = (err as { headers: Record<string, string> }).headers;
    const retryAfter = headers?.["retry-after"] ?? headers?.["Retry-After"];
    if (retryAfter) {
      const parsed = Number(retryAfter);
      if (!Number.isNaN(parsed)) return parsed * 1000;
    }
  }
  return null;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = {}
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULT_POLICY, ...policy };
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isRetryable(err)) throw err;
      const fromHeader = retryAfterMs(err);
      const backoff = fromHeader ?? Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      // Add up to 20% jitter to spread retries.
      const jitter = backoff * (0.8 + Math.random() * 0.4);
      await new Promise((res) => setTimeout(res, jitter));
      attempt++;
    }
  }
}

/**
 * Wrap an async generator with retry logic.
 * The entire generator is restarted on retryable failures.
 */
export async function* withRetryGenerator<T>(
  fn: () => AsyncGenerator<T>,
  policy: RetryPolicy = {}
): AsyncGenerator<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULT_POLICY, ...policy };
  let attempt = 0;
  while (true) {
    try {
      yield* fn();
      return;
    } catch (err) {
      if (attempt >= maxRetries || !isRetryable(err)) throw err;
      const fromHeader = retryAfterMs(err);
      const backoff = fromHeader ?? Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const jitter = backoff * (0.8 + Math.random() * 0.4);
      await new Promise((res) => setTimeout(res, jitter));
      attempt++;
    }
  }
}
