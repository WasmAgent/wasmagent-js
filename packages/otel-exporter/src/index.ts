/**
 * OtlpHttpExporter — OTLP/HTTP (protobuf-JSON) span exporter for @wasmagent/core.
 *
 * Implements the SpanExporter interface from @wasmagent/core/observability and
 * ships completed spans to any OTLP-compatible collector (Jaeger, Grafana Tempo,
 * Datadog, Elastic APM, etc.) via HTTP POST.
 *
 * Usage:
 *   import { OtlpHttpExporter } from "@wasmagent/otel-exporter";
 *   import { OtelBridge, withOtel } from "@wasmagent/core/experimental";
 *
 *   const exporter = new OtlpHttpExporter({ endpoint: "http://localhost:4318" });
 *   const bridge = new OtelBridge({ exporter });
 *   for await (const ev of withOtel(agent.run("task"), bridge)) { ... }
 *
 * Wire format: OTLP JSON over HTTP (protobuf-JSON encoding, per OTLP spec §1.3).
 * This avoids a protobuf compile dependency while remaining compatible with all
 * major collectors that accept Content-Type: application/json.
 *
 * Anthropic-specific semconv attributes:
 *   gen_ai.system = "anthropic"
 *   gen_ai.usage.cache_read_input_tokens
 *   gen_ai.usage.cache_read_input_tokens_1h   (extended TTL, Anthropic-specific)
 *   gen_ai.anthropic.thinking_tokens
 */

import type {
  GenAiMetricPoint,
  MetricExporter,
  ReadableSpan,
  SpanAttributes,
  SpanExporter,
} from "@wasmagent/core/experimental";

export interface OtlpHttpExporterOptions {
  /**
   * OTLP collector base URL. Spans are POSTed to <endpoint>/v1/traces.
   * Default: http://localhost:4318
   */
  endpoint?: string;
  /**
   * Custom HTTP headers (e.g. authentication tokens).
   * Example: { "x-datadog-api-key": "..." }
   */
  headers?: Record<string, string>;
  /**
   * Timeout in milliseconds for each export HTTP request.
   * Default: 5000
   */
  timeoutMs?: number;
  /**
   * Service name for the resource span wrapper.
   * Default: "wasmagent"
   */
  serviceName?: string;
  /**
   * Service version added to resource attributes.
   */
  serviceVersion?: string;
  /**
   * O4: Max retry attempts for failed exports (HTTP 5xx / network errors).
   * Default: 3. Set to 0 to disable retries.
   */
  maxRetries?: number;
  /**
   * O4: Initial retry delay in milliseconds (doubles on each attempt).
   * Default: 1000.
   */
  retryDelayMs?: number;
}

/**
 * OTLP/HTTP span + metrics exporter (JSON encoding).
 *
 * Implements SpanExporter + MetricExporter from @wasmagent/core and posts
 * batches of completed spans/metrics to an OTLP-compatible collector.
 *
 * O4: Failed exports are retried with exponential backoff.
 * O2: GenAI client metrics are posted to /v1/metrics when available.
 */
export class OtlpHttpExporter implements SpanExporter, MetricExporter {
  readonly #traceEndpoint: string;
  readonly #metricsEndpoint: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number;
  readonly #resource: Record<string, string>;

  constructor(opts: OtlpHttpExporterOptions = {}) {
    const base = (opts.endpoint ?? "http://localhost:4318").replace(/\/$/, "");
    this.#traceEndpoint = `${base}/v1/traces`;
    this.#metricsEndpoint = `${base}/v1/metrics`;
    this.#headers = {
      "Content-Type": "application/json",
      ...opts.headers,
    };
    this.#timeoutMs = opts.timeoutMs ?? 5000;
    this.#maxRetries = opts.maxRetries ?? 3;
    this.#retryDelayMs = opts.retryDelayMs ?? 1000;
    this.#resource = {
      "service.name": opts.serviceName ?? "wasmagent",
      ...(opts.serviceVersion ? { "service.version": opts.serviceVersion } : {}),
    };
  }

  /**
   * Export a batch of completed spans to the OTLP collector.
   * Failures are retried with exponential backoff (O4), then logged.
   */
  export(spans: ReadableSpan[]): void {
    if (spans.length === 0) return;
    const body = this.#toOtlpPayload(spans);
    this.#exportWithRetry(this.#traceEndpoint, body).catch((err) => {
      console.error(
        "[OtlpHttpExporter] trace export failed after retries:",
        (err as Error)?.message ?? err
      );
    });
  }

  /**
   * O2: Export GenAI metrics to /v1/metrics.
   */
  exportMetrics(metrics: GenAiMetricPoint[]): void {
    if (metrics.length === 0) return;
    const body = this.#toOtlpMetricsPayload(metrics);
    this.#exportWithRetry(this.#metricsEndpoint, body).catch((err) => {
      console.error(
        "[OtlpHttpExporter] metrics export failed after retries:",
        (err as Error)?.message ?? err
      );
    });
  }

  /**
   * Export and await completion (useful in test environments or graceful shutdown).
   */
  async exportAsync(spans: ReadableSpan[]): Promise<void> {
    if (spans.length === 0) return;
    const body = this.#toOtlpPayload(spans);
    await this.#exportWithRetry(this.#traceEndpoint, body);
  }

  /** O4: Export with exponential backoff retry. */
  async #exportWithRetry(endpoint: string, body: object): Promise<void> {
    let lastError: Error | undefined;
    let delayMs = this.#retryDelayMs;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((r) => setTimeout(r, delayMs));
        delayMs = Math.min(delayMs * 2, 30_000);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: this.#headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (res.ok) return;
        // 4xx errors are not retryable (client error)
        if (res.status >= 400 && res.status < 500) {
          const t = await res.text().catch(() => "");
          throw new Error(`OTLP export HTTP ${res.status}: ${t.slice(0, 200)}`);
        }
        // 5xx: retryable
        lastError = new Error(`OTLP export HTTP ${res.status} (retrying)`);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          lastError = new Error("OTLP export timed out");
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error("OTLP export failed");
  }

  /** Convert internal ReadableSpan[] to OTLP JSON trace payload. */
  #toOtlpPayload(spans: ReadableSpan[]): OtlpTracesPayload {
    // Build resource attributes from #resource map
    const resourceAttrs = Object.entries(this.#resource).map(([k, v]) => ({
      key: k,
      value: { stringValue: v },
    }));

    const otlpSpans = spans.map((s) => this.#toOtlpSpan(s));

    return {
      resourceSpans: [
        {
          resource: { attributes: resourceAttrs },
          scopeSpans: [
            {
              scope: { name: "@wasmagent/otel-exporter", version: "0.1.0" },
              spans: otlpSpans,
            },
          ],
        },
      ],
    };
  }

  #toOtlpSpan(s: ReadableSpan): OtlpSpan {
    const startNs = msToNs(s.startTimeMs);
    const endNs = msToNs(s.endTimeMs ?? s.startTimeMs);
    // Filter internal tracking attributes (prefixed with _) from export.
    const filteredAttrs: typeof s.attributes = {};
    for (const [k, v] of Object.entries(s.attributes)) {
      if (!k.startsWith("_")) filteredAttrs[k] = v;
    }
    const attrs = attributesToOtlp(filteredAttrs);

    const statusCode =
      s.status === "ok"
        ? 1 /* STATUS_CODE_OK */
        : s.status === "error"
          ? 2 /* STATUS_CODE_ERROR */
          : 0; /* STATUS_CODE_UNSET */

    return {
      traceId: ensureHex(s.traceId, 32),
      spanId: ensureHex(s.spanId, 16),
      ...(s.parentSpanId ? { parentSpanId: ensureHex(s.parentSpanId, 16) } : {}),
      name: s.name,
      kind: 2, // SPAN_KIND_SERVER
      startTimeUnixNano: startNs,
      endTimeUnixNano: endNs,
      attributes: attrs,
      status: { code: statusCode },
      events: s.events.map((e: { name: string; timestampMs: number; attributes?: Record<string, unknown> }) => ({
        name: e.name,
        timeUnixNano: msToNs(e.timestampMs),
        attributes: e.attributes ? attributesToOtlp(e.attributes as SpanAttributes) : [],
      })),
    };
  }

  /** O2: Convert GenAI metric points to OTLP JSON metrics payload. */
  #toOtlpMetricsPayload(metrics: GenAiMetricPoint[]): object {
    const resourceAttrs = Object.entries(this.#resource).map(([k, v]) => ({
      key: k,
      value: { stringValue: v },
    }));

    // Aggregate by model: sum tokens, collect durations for histogram approximation.
    const byModel = new Map<
      string,
      { inputTokens: number; outputTokens: number; durations: number[] }
    >();
    for (const m of metrics) {
      let bucket = byModel.get(m.modelId);
      if (!bucket) {
        bucket = { inputTokens: 0, outputTokens: 0, durations: [] };
        byModel.set(m.modelId, bucket);
      }
      if (m.inputTokens !== undefined) bucket.inputTokens += m.inputTokens;
      if (m.outputTokens !== undefined) bucket.outputTokens += m.outputTokens;
      if (m.durationMs !== undefined) bucket.durations.push(m.durationMs);
    }

    const dataPoints: object[] = [];
    for (const [modelId, data] of byModel) {
      const attrs = [{ key: "gen_ai.request.model", value: { stringValue: modelId } }];
      if (data.inputTokens > 0) {
        dataPoints.push({
          attributes: [...attrs, { key: "gen_ai.token.type", value: { stringValue: "input" } }],
          asInt: String(data.inputTokens),
        });
      }
      if (data.outputTokens > 0) {
        dataPoints.push({
          attributes: [...attrs, { key: "gen_ai.token.type", value: { stringValue: "output" } }],
          asInt: String(data.outputTokens),
        });
      }
      // data.durations available for histogram export in future
    }

    return {
      resourceMetrics: [
        {
          resource: { attributes: resourceAttrs },
          scopeMetrics: [
            {
              scope: { name: "@wasmagent/otel-exporter", version: "0.1.0" },
              metrics: [
                {
                  name: "gen_ai.client.token.usage",
                  description: "GenAI client token usage",
                  unit: "token",
                  sum: { dataPoints, aggregationTemporality: 1, isMonotonic: true },
                },
              ],
            },
          ],
        },
      ],
    };
  }
}

// ── OTLP JSON type helpers ─────────────────────────────────────────────────────

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string; // OTLP uses string for int64
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

interface OtlpResource {
  attributes: OtlpKeyValue[];
}

interface OtlpInstrumentationScope {
  name: string;
  version?: string;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: { code: number; message?: string };
  events: Array<{ name: string; timeUnixNano: string; attributes: OtlpKeyValue[] }>;
}

interface OtlpScopeSpans {
  scope: OtlpInstrumentationScope;
  spans: OtlpSpan[];
}

interface OtlpResourceSpans {
  resource: OtlpResource;
  scopeSpans: OtlpScopeSpans[];
}

interface OtlpTracesPayload {
  resourceSpans: OtlpResourceSpans[];
}

function msToNs(ms: number): string {
  // ms → nanoseconds, returned as a string to preserve int64 precision
  return String(Math.round(ms) * 1_000_000);
}

/**
 * Ensure a W3C-valid hex ID of the expected length.
 * If the ID is already valid hex of the right length, pass through.
 * Otherwise strip non-hex chars and pad/truncate — but only as a last resort
 * to avoid dropping spans with IDs from legacy bridge versions.
 */
function ensureHex(id: string, targetLen: number): string {
  // Fast path: already valid
  if (id.length === targetLen && /^[0-9a-f]+$/.test(id)) return id;
  // Strip non-hex and adjust length
  const stripped = id.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (stripped.length === 0) {
    // All-zeros is the W3C invalid marker; use it to signal bad input.
    return "0".repeat(targetLen);
  }
  return stripped.padStart(targetLen, "0").slice(-targetLen);
}

function attributesToOtlp(attrs: SpanAttributes): OtlpKeyValue[] {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      const value: OtlpAnyValue =
        typeof v === "string"
          ? { stringValue: v }
          : typeof v === "number"
            ? Number.isInteger(v)
              ? { intValue: String(v) }
              : { doubleValue: v }
            : typeof v === "boolean"
              ? { boolValue: v }
              : { stringValue: String(v) };
      return { key: k, value };
    });
}

// ── M5.3 — sampler / redactor / baggage / fine-grained metrics ──

export type { Baggage } from "./BaggagePropagator.js";
export {
  extractBaggage,
  injectBaggage,
  parseBaggageHeader,
  serializeBaggage,
} from "./BaggagePropagator.js";
export type { MetricsSnapshot, StepMetric, ToolErrorMetric } from "./FineGrainedMetrics.js";
export { FineGrainedMetrics } from "./FineGrainedMetrics.js";
export type { Sampler } from "./Sampler.js";
export {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ProbabilisticSampler,
  RateLimitingSampler,
} from "./Sampler.js";
export type { TraceRedactorOpts } from "./TraceRedactor.js";
export { TraceRedactor } from "./TraceRedactor.js";
