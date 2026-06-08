/**
 * FallbackModel — provider failover for the Model interface (C3).
 *
 * When the primary model fails with a non-retryable error or exhausts its
 * retry budget, FallbackModel automatically tries the next model in the list.
 * The switch is transparent to the calling agent — all options (cacheBreakpoint,
 * responseFormat, thinking, etc.) are forwarded unchanged.
 *
 * Compatible with AI Gateway pattern (Vercel AI SDK 6, 2025-12):
 *   const model = new FallbackModel([primaryModel, secondaryModel, tertiaryModel]);
 *
 * OTel integration: when used with OtelBridge, the gen_ai.system attribute
 * on the model span reflects the actual provider that responded (not always
 * the primary). Caller should wrap FallbackModel with withOtel() for tracing.
 */

import type { Model, ModelCapabilities, ModelMessage, GenerateOptions, StreamEvent } from "./types.js";

// ── FallbackModel ──────────────────────────────────────────────────────────────

export interface FallbackModelOptions {
  /**
   * Ordered list of models to try. The first model is the primary.
   * If it fails with a non-retryable error, the next is tried, and so on.
   */
  models: Model[];
}

function isNonRetryable(err: unknown): boolean {
  if (err instanceof Error && "status" in err) {
    const status = (err as { status: number }).status;
    // 4xx (except 429 rate-limit) are non-retryable; 5xx are retryable.
    if (status === 429) return false; // retryable (rate-limit)
    if (status >= 400 && status < 500) return true; // non-retryable (auth, bad request, etc.)
    return false; // 5xx — retryable
  }
  // Network errors, ECONNRESET, etc. — treat as retryable for intra-model policy
  // but still fall through to the next model after all retries are exhausted.
  return false;
}

/**
 * FallbackModel — tries each model in order until one succeeds.
 *
 * Switching happens when:
 *   1. A non-retryable error is thrown (e.g. 403, 404 — wrong API key / model not found).
 *   2. All intra-model retries are exhausted (e.g. 5xx after maxRetries attempts).
 *      FallbackModel itself does NOT retry — it relies on each wrapped model's own
 *      RetryPolicy. When a model exhausts its retries and still throws, FallbackModel
 *      moves to the next model.
 *
 * The generate() method yields from the first successful model's stream.
 * Partial streams (where some events were yielded before failure) are NOT replayed —
 * the next model starts fresh.
 */
export class FallbackModel implements Model {
  readonly #models: Model[];

  /** The providerId of the model that actually responded last time. */
  #lastProviderId: string;

  /** Merged capabilities exposed as an optional public field. */
  readonly capabilities?: ModelCapabilities;

  constructor(models: Model[]) {
    if (models.length === 0) throw new Error("FallbackModel requires at least one model");
    this.#models = models;
    this.#lastProviderId = models[0]!.providerId;
    // Pre-compute merged capabilities.
    const caps: ModelCapabilities = {};
    for (const m of models) {
      if (!m.capabilities) continue;
      if (m.capabilities.localEndpoint) caps.localEndpoint = true;
      if (m.capabilities.metered !== undefined) caps.metered = m.capabilities.metered;
      if (m.capabilities.supportsGrammar) caps.supportsGrammar = true;
      if (m.capabilities.supportsBudgetForcing) caps.supportsBudgetForcing = true;
      if (m.capabilities.contextWindow) caps.contextWindow = Math.max(caps.contextWindow ?? 0, m.capabilities.contextWindow);
      if (m.capabilities.supportsReasoningEffort) caps.supportsReasoningEffort = true;
      if (m.capabilities.supportsVerbosity) caps.supportsVerbosity = true;
      if (!caps.cacheStrategy && m.capabilities.cacheStrategy) caps.cacheStrategy = m.capabilities.cacheStrategy;
    }
    if (Object.keys(caps).length > 0) {
      this.capabilities = caps;
    }
  }

  /** Primary model's providerId (for interface compliance). */
  get providerId(): string {
    return this.#models[0]!.providerId;
  }

  /** The providerId of the model that successfully responded on the last generate() call. */
  get lastActiveProviderId(): string {
    return this.#lastProviderId;
  }

  async *generate(
    messages: ModelMessage[],
    opts: GenerateOptions = {}
  ): AsyncGenerator<StreamEvent> {
    let lastError: unknown;

    for (let i = 0; i < this.#models.length; i++) {
      const model = this.#models[i]!;
      let yieldedAny = false;
      try {
        if (i === 0) {
          // Primary model: stream directly for minimal first-token latency.
          // If it throws AFTER yielding events, the caller has partial state and
          // falling over would corrupt their accumulation — propagate immediately.
          // If it throws before yielding anything, fall through to the next model.
          for await (const ev of model.generate(messages, opts)) {
            yieldedAny = true;
            yield ev;
          }
        } else {
          // Fallback models: buffer to avoid yielding a partial stream that then fails.
          const events: StreamEvent[] = [];
          for await (const ev of model.generate(messages, opts)) {
            events.push(ev);
          }
          yield* events;
        }
        this.#lastProviderId = model.providerId;
        return;
      } catch (err) {
        if (yieldedAny) throw err;
        lastError = err;
      }
    }

    throw lastError ?? new Error("FallbackModel: all models failed");
  }
}
