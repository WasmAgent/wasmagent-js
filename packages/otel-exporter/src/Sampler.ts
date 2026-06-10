/**
 * Sampler — decides whether a given trace should be exported.
 *
 * Three built-in implementations:
 * - {@link AlwaysOnSampler} — export every trace (default)
 * - {@link AlwaysOffSampler} — drop every trace (useful in CI / tests)
 * - {@link ProbabilisticSampler} — random fraction (deterministic by traceId)
 * - {@link RateLimitingSampler} — at most N traces per second
 */

export interface Sampler {
  /** Return true to export the trace, false to drop it. */
  shouldSample(traceId: string, attributes?: Record<string, unknown>): boolean;
}

export class AlwaysOnSampler implements Sampler {
  shouldSample(_traceId: string): boolean {
    return true;
  }
}

export class AlwaysOffSampler implements Sampler {
  shouldSample(_traceId: string): boolean {
    return false;
  }
}

/** Hash a trace id to a stable [0, 1) value for deterministic sampling. */
function traceIdToUnitInterval(traceId: string): number {
  // FNV-1a 32-bit on the trace id, normalized.
  let h = 2166136261;
  for (let i = 0; i < traceId.length; i++) {
    h ^= traceId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) / 0x100000000;
}

/**
 * Probabilistic sampler — exports a fixed fraction of traces, with the
 * decision deterministic per traceId so retries / parallel handlers
 * agree on whether to keep the trace.
 */
export class ProbabilisticSampler implements Sampler {
  readonly #rate: number;

  constructor(rate: number) {
    if (rate < 0 || rate > 1)
      throw new Error(`ProbabilisticSampler: rate must be in [0, 1], got ${rate}`);
    this.#rate = rate;
  }

  shouldSample(traceId: string): boolean {
    if (this.#rate >= 1) return true;
    if (this.#rate <= 0) return false;
    return traceIdToUnitInterval(traceId) < this.#rate;
  }
}

/**
 * Rate-limiting sampler — admits at most `qps` traces per second.
 * Useful for spike protection on high-cardinality services.
 */
export class RateLimitingSampler implements Sampler {
  readonly #qps: number;
  #windowStart = 0;
  #count = 0;

  constructor(qps: number) {
    if (qps < 0) throw new Error(`RateLimitingSampler: qps must be non-negative, got ${qps}`);
    this.#qps = qps;
  }

  shouldSample(_traceId: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    if (now !== this.#windowStart) {
      this.#windowStart = now;
      this.#count = 0;
    }
    if (this.#count >= this.#qps) return false;
    this.#count++;
    return true;
  }
}
