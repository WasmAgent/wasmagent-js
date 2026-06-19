/**
 * Per-user rate limiting backed by Cloudflare KV.
 *
 * Sliding-window counter implementation:
 * - Each (userId, route) pair gets a key whose value is a JSON array
 *   of timestamps within the window.
 * - On every check, prune timestamps older than the window, count the
 *   rest, and reject if over the cap.
 *
 * For higher-volume production, use Cloudflare Rate Limiting bindings
 * directly. This implementation is good enough for low-to-mid traffic
 * and works without any additional binding setup.
 */

export interface RateLimitOpts {
  /** Requests per minute. Default: 60. */
  rpm?: number;
  /** Optional tokens per minute (caller decides what counts as a token). */
  tpm?: number;
  /** Window length in ms. Default: 60_000. */
  windowMs?: number;
}

export interface RateLimitBackend {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export interface RateLimitCheck {
  allowed: boolean;
  /** When the next request would be permitted (Unix ms). */
  retryAtMs: number;
  /** How many requests remain in the current window. */
  remaining: number;
}

/**
 * Check + record a request against the limiter.
 *
 * Returns `allowed: true` when the request is under the quota; in this
 * case the caller should let the request through. When `false`, return
 * 429 to the client with `Retry-After: <seconds>`.
 */
export async function checkRateLimit(
  backend: RateLimitBackend,
  identityKey: string,
  opts: RateLimitOpts = {}
): Promise<RateLimitCheck> {
  const rpm = opts.rpm ?? 60;
  const windowMs = opts.windowMs ?? 60_000;
  const now = Date.now();
  const cutoff = now - windowMs;

  const raw = await backend.get(identityKey);
  let timestamps: number[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as number[];
      if (!Array.isArray(parsed)) {
        // Wrong shape — treat as a corrupted record. Fail closed
        // for one window to prevent a drive-by quota reset attack.
        return {
          allowed: false,
          retryAtMs: now + windowMs,
          remaining: 0,
        };
      }
      timestamps = parsed.filter((t) => typeof t === "number" && t > cutoff);
      timestamps.sort((a, b) => a - b);
    } catch {
      // Parse failure → fail closed for one window. The alternative
      // (silently resetting to 0) lets a malicious or buggy writer
      // erase the rate limiter, so we refuse the request and let the
      // next put() above re-establish a clean record.
      return {
        allowed: false,
        retryAtMs: now + windowMs,
        remaining: 0,
      };
    }
  }

  if (timestamps.length >= rpm) {
    const earliest = timestamps[0] ?? now;
    return {
      allowed: false,
      retryAtMs: earliest + windowMs,
      remaining: 0,
    };
  }

  timestamps.push(now);
  await backend.put(identityKey, JSON.stringify(timestamps), {
    expirationTtl: Math.max(60, Math.ceil(windowMs / 1000) + 5),
  });

  return {
    allowed: true,
    retryAtMs: now,
    remaining: Math.max(0, rpm - timestamps.length),
  };
}

/**
 * Build an HTTP 429 Response with the standard `Retry-After` header.
 */
export function rateLimitedResponse(check: RateLimitCheck, message?: string): Response {
  const retryAfterSec = Math.max(1, Math.ceil((check.retryAtMs - Date.now()) / 1000));
  return new Response(
    JSON.stringify({
      error: "rate_limited",
      message: message ?? "Too many requests",
      retryAfterSec,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec),
      },
    }
  );
}
