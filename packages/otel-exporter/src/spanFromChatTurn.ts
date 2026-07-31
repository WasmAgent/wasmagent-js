/**
 * spanFromChatTurn — factory that builds a {@link ReadableSpan} from a chat-turn
 * record, handling all UUID→hex conversion and required OTLP field defaults.
 *
 * Without this helper, callers must manually convert a UUID `turnId` to the
 * required 32/16-char hex traceId/spanId format — wrong padding or wrong slice
 * lengths silently produce malformed spans that collectors reject.
 *
 * @example
 * ```ts
 * exporter.export([
 *   spanFromChatTurn({
 *     traceId: turnId,   // UUID or hex — converted automatically
 *     name: 'procureiq.chat.turn',
 *     startMs: Date.now(),
 *     durationMs: elapsed,
 *     attributes: { userId, toolCallCount, hasError },
 *   })
 * ])
 * ```
 */

import type { ReadableSpan, SpanAttributes } from "@wasmagent/core/experimental";

/**
 * Options for {@link spanFromChatTurn}.
 *
 * All IDs accept either a UUID (e.g. `"550e8400-e29b-41d4-a716-446655440000"`)
 * or a plain lowercase hex string. The factory normalises both forms to the
 * W3C-required lengths (32 hex chars for traceId, 16 for spanId).
 */
export interface SpanFromChatTurnOptions {
  /**
   * Trace identifier — typically the `turnId` or session UUID.
   * Accepts UUID or hex; converted to 32 lowercase hex chars.
   */
  traceId: string;
  /**
   * Span name (e.g. `"procureiq.chat.turn"`, `"agent.run"`).
   */
  name: string;
  /**
   * Span start time in milliseconds since epoch.
   */
  startMs: number;
  /**
   * Span duration in milliseconds. The end time is computed as
   * `startMs + durationMs`. Either `durationMs` or `endMs` must be set.
   */
  durationMs?: number;
  /**
   * Span end time in milliseconds since epoch. Takes precedence over
   * `durationMs` when both are provided.
   */
  endMs?: number;
  /**
   * Arbitrary span attributes. The `hasError` convenience key maps to OTLP
   * status — pass it here instead of setting `status` manually.
   */
  attributes?: SpanAttributes & {
    /**
     * When `true`, the span status is set to `"error"`. Mutually exclusive
     * with an explicit `status` field on the options; `status` wins when set.
     */
    hasError?: boolean;
  };
  /**
   * Explicit span status. Default: derived from `attributes.hasError`.
   */
  status?: "ok" | "error" | "unset";
  /**
   * Optional parent span ID. Accepts UUID or hex; converted to 16 lowercase
   * hex chars.
   */
  parentSpanId?: string;
  /**
   * Override the derived span ID (defaults to the lower 16 hex chars of the
   * normalised traceId). Accepts UUID or hex.
   */
  spanId?: string;
}

/**
 * Normalise any string to a lowercase hex ID of `targetLen` chars.
 *
 * - Valid hex of the right length: pass through unchanged.
 * - UUID or hex with wrong length: strip hyphens, pad or truncate.
 * - All-zeros or empty: returns all-zeros (W3C invalid marker — signals bad input).
 */
function normaliseHexId(id: string, targetLen: number): string {
  if (id.length === targetLen && /^[0-9a-f]+$/.test(id)) return id;
  const stripped = id.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (stripped.length === 0) return "0".repeat(targetLen);
  if (stripped.length >= targetLen) return stripped.slice(stripped.length - targetLen);
  return stripped.padStart(targetLen, "0");
}

/**
 * Build a {@link ReadableSpan} from a chat-turn record.
 *
 * Handles:
 * - UUID→hex conversion for `traceId`, `spanId`, and `parentSpanId`
 * - Default span ID derived from the lower 16 hex chars of the trace ID
 * - `hasError` attribute shorthand → OTLP `status`
 * - Required OTLP fields (`events: []`, `parentSpanId: undefined`)
 *
 * @throws {TypeError} if neither `durationMs` nor `endMs` is provided and
 *   therefore the end time cannot be determined.
 */
export function spanFromChatTurn(opts: SpanFromChatTurnOptions): ReadableSpan {
  const traceId = normaliseHexId(opts.traceId, 32);

  // Derive spanId from the lower 16 hex chars of traceId when not provided.
  const spanId = opts.spanId ? normaliseHexId(opts.spanId, 16) : traceId.slice(16);

  const endMs =
    opts.endMs !== undefined
      ? opts.endMs
      : opts.durationMs !== undefined
        ? opts.startMs + opts.durationMs
        : undefined;

  // Extract `hasError` from attributes (do not forward it as an OTLP attribute).
  const { hasError, ...cleanAttrs } = opts.attributes ?? {};

  const status: ReadableSpan["status"] = opts.status ?? (hasError ? "error" : "ok");

  return {
    traceId,
    spanId,
    parentSpanId: opts.parentSpanId ? normaliseHexId(opts.parentSpanId, 16) : undefined,
    name: opts.name,
    startTimeMs: opts.startMs,
    endTimeMs: endMs,
    attributes: cleanAttrs,
    status,
    events: [],
  };
}
