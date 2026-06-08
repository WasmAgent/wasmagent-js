/**
 * OtlpHttpExporter — OTLP/HTTP (protobuf-JSON) span exporter for @agentkit-js/core.
 *
 * Implements the SpanExporter interface from @agentkit-js/core/observability and
 * ships completed spans to any OTLP-compatible collector (Jaeger, Grafana Tempo,
 * Datadog, Elastic APM, etc.) via HTTP POST.
 *
 * Usage:
 *   import { OtlpHttpExporter } from "@agentkit-js/otel-exporter";
 *   import { OtelBridge, withOtel } from "@agentkit-js/core";
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

import type { SpanExporter, ReadableSpan, SpanAttributes } from "@agentkit-js/core";

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
   * Default: "agentkit"
   */
  serviceName?: string;
  /**
   * Service version added to resource attributes.
   */
  serviceVersion?: string;
}

/**
 * OTLP/HTTP span exporter (JSON encoding).
 *
 * Implements SpanExporter from @agentkit-js/core and posts batches of
 * completed spans to an OTLP-compatible collector.
 */
export class OtlpHttpExporter implements SpanExporter {
  readonly #endpoint: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #resource: Record<string, string>;

  constructor(opts: OtlpHttpExporterOptions = {}) {
    const base = (opts.endpoint ?? "http://localhost:4318").replace(/\/$/, "");
    this.#endpoint = `${base}/v1/traces`;
    this.#headers = {
      "Content-Type": "application/json",
      ...opts.headers,
    };
    this.#timeoutMs = opts.timeoutMs ?? 5000;
    this.#resource = {
      "service.name": opts.serviceName ?? "agentkit",
      ...(opts.serviceVersion ? { "service.version": opts.serviceVersion } : {}),
    };
  }

  /**
   * Export a batch of completed spans to the OTLP collector.
   * Failures are logged to stderr and swallowed (fire-and-forget).
   */
  export(spans: ReadableSpan[]): void {
    if (spans.length === 0) return;
    const body = this.#toOtlpPayload(spans);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    fetch(this.#endpoint, {
      method: "POST",
      headers: this.#headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) {
          res.text().then((t) => {
            console.error(`[OtlpHttpExporter] export failed ${res.status}: ${t.slice(0, 200)}`);
          }).catch(() => {});
        }
      })
      .catch((err) => {
        if ((err as Error)?.name !== "AbortError") {
          console.error("[OtlpHttpExporter] export error:", (err as Error)?.message ?? err);
        }
      })
      .finally(() => clearTimeout(timer));
  }

  /**
   * Export and await completion (useful in test environments or graceful shutdown).
   */
  async exportAsync(spans: ReadableSpan[]): Promise<void> {
    if (spans.length === 0) return;
    const body = this.#toOtlpPayload(spans);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const res = await fetch(this.#endpoint, {
        method: "POST",
        headers: this.#headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`OTLP export failed ${res.status}: ${t.slice(0, 200)}`);
      }
    } finally {
      clearTimeout(timer);
    }
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
              scope: { name: "@agentkit-js/otel-exporter", version: "0.1.0" },
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
    const attrs = attributesToOtlp(s.attributes);

    const statusCode =
      s.status === "ok" ? 1 /* STATUS_CODE_OK */
      : s.status === "error" ? 2 /* STATUS_CODE_ERROR */
      : 0; /* STATUS_CODE_UNSET */

    return {
      traceId: padHex(s.traceId, 32),
      spanId: padHex(s.spanId, 16),
      ...(s.parentSpanId ? { parentSpanId: padHex(s.parentSpanId, 16) } : {}),
      name: s.name,
      kind: 2, // SPAN_KIND_SERVER
      startTimeUnixNano: startNs,
      endTimeUnixNano: endNs,
      attributes: attrs,
      status: { code: statusCode },
      events: s.events.map((e) => ({
        name: e.name,
        timeUnixNano: msToNs(e.timestampMs),
        attributes: e.attributes ? attributesToOtlp(e.attributes) : [],
      })),
    };
  }
}

// ── OTLP JSON type helpers ─────────────────────────────────────────────────────

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;  // OTLP uses string for int64
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

function padHex(id: string, targetLen: number): string {
  // Strip "span-" / "agent-" prefixes and pad to targetLen hex chars
  const stripped = id.replace(/^[a-z-]+-/i, "").replace(/-/g, "");
  return stripped.padStart(targetLen, "0").slice(0, targetLen);
}

function attributesToOtlp(attrs: SpanAttributes): OtlpKeyValue[] {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      const value: OtlpAnyValue =
        typeof v === "string" ? { stringValue: v }
        : typeof v === "number" ? Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }
        : typeof v === "boolean" ? { boolValue: v }
        : { stringValue: String(v) };
      return { key: k, value };
    });
}
