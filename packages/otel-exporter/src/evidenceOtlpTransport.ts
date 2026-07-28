/**
 * evidenceOtlpTransport.ts — OpenTelemetry transport for AEP evidence streaming
 * (Milestone 7, #276).
 *
 * `OtlpEvidenceTransport` is a {@link StreamTransportOutbound} that converts each
 * published AEP record into one OTLP trace span **per action** (reusing
 * `aepActionToOtelSpan` from the AEP↔OTel bridge) and POSTs the resulting OTLP
 * traces payload to any OTLP/HTTP-compatible collector (Jaeger, Grafana Tempo,
 * Datadog, Elastic APM, …). This is the "external observability pipelines
 * (OpenTelemetry integration)" half of the milestone bullet.
 *
 * Wire it onto an `EvidencePublisher` (or any `EvidenceStream`) to mirror a live
 * evidence feed into an OTel backend:
 *
 * ```ts
 * import { EvidencePublisher } from "@wasmagent/aep";
 * import { OtlpEvidenceTransport } from "@wasmagent/otel-exporter";
 *
 * const publisher = new EvidencePublisher({ topic: "live-evidence" });
 * publisher.addTransport(new OtlpEvidenceTransport({ endpoint: "http://collector:4318" }));
 * await publisher.publish(record); // → record's actions appear as OTLP spans
 * ```
 *
 * ## Dependency boundary
 *
 * This module references `@wasmagent/aep` **only** via `import type` (the
 * `StreamEvent` / `StreamTransportOutbound` shapes). The compiled output has
 * zero runtime dependency on the evidence layer — `@wasmagent/aep` is a
 * devDependency used purely for typing and integration tests, mirroring the
 * `@wasmagent/core/shared-state/aep` pattern.
 */

// Type-only imports keep the runtime dependency-free (see module doc).
import type { StreamEvent, StreamTransportOutbound } from "@wasmagent/aep";
import { type AepActionLike, aepActionToOtelSpan, type OtelSpanLike } from "./aep-otel-bridge.js";

/** Attribute value shape produced by `aepActionToOtelSpan` (mirrors OTel SDK). */
type AttributeValue = string | number | boolean | string[] | number[] | boolean[];

/** A single OTLP/JSON `AnyValue` (protobuf-JSON encoding, per OTLP spec §1.3). */
interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string; // OTLP encodes int64 as a JSON string
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpAnyValue[] };
}

/** A single OTLP/JSON key/value attribute. */
interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

/** The OTLP/JSON representation of a span (subset posted to /v1/traces). */
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
  events: [];
}

/**
 * Structural action shape used as the input to the OTLP conversion.
 *
 * `AEPRecord.actions` come from a zod schema, whose optional fields are typed
 * `T | undefined`. Under `exactOptionalPropertyTypes` that is not assignable to
 * {@link AepActionLike}'s `?: T` optionals (which forbid explicit `undefined`).
 * This loose mirror allows explicit `undefined`, so a real `AEPRecord` is
 * assignable; we then narrow to {@link AepActionLike} at the bridge boundary,
 * where the runtime shape is fully compatible (every field the bridge reads is
 * present or genuinely optional).
 */
interface LooseAepAction {
  action_id: string;
  tool_name: string;
  state_changing: boolean;
  timestamp_ms: number;
  parent_action_id?: string | undefined;
  causal_chain_id?: string | undefined;
  scope_lease_id?: string | undefined;
  input_taint_labels?: string[] | undefined;
  output_taint_labels?: string[] | undefined;
  result_digest?: string | undefined;
  pre_state_digest?: string | undefined;
  post_state_digest?: string | undefined;
  capability_decision?:
    | {
        decision: string;
        reason_code?: string | undefined;
        capability: string;
        subject: string;
        resource: string;
      }
    | undefined;
}

/** Options for constructing an {@link OtlpEvidenceTransport}. */
export interface OtlpEvidenceTransportOptions {
  /**
   * OTLP collector base URL. Traces are POSTed to `<endpoint>/v1/traces`.
   * Default: `http://localhost:4318`.
   */
  readonly endpoint?: string;
  /** Custom HTTP headers (e.g. authentication tokens), merged over Content-Type. */
  readonly headers?: Record<string, string>;
  /** `service.name` resource attribute for the exported spans. Default: `wasmagent`. */
  readonly serviceName?: string;
  /** Extra resource attributes attached to every exported span. */
  readonly resourceAttributes?: Record<string, string>;
  /** Per-export HTTP timeout in milliseconds. Default: `5000`. */
  readonly timeoutMs?: number;
  /** Max retry attempts for failed exports (HTTP 5xx / network errors). Default: `3`. */
  readonly maxRetries?: number;
  /** Initial retry delay in milliseconds (doubles each attempt, capped at 30s). Default: `1000`. */
  readonly retryDelayMs?: number;
  /** Override `fetch` (for tests and non-browser runtimes). Defaults to global `fetch`. */
  readonly fetcher?: typeof fetch;
}

/** Convert an `OtelSpanLike` (numeric nanos) into OTLP/JSON span encoding. */
function otelSpanToOtlp(s: OtelSpanLike): OtlpSpan {
  const span: OtlpSpan = {
    traceId: ensureHex(s.traceId, 32),
    spanId: ensureHex(s.spanId, 16),
    name: s.name,
    kind: 2, // SPAN_KIND_SERVER
    startTimeUnixNano: String(s.startTimeUnixNano),
    endTimeUnixNano: String(s.endTimeUnixNano),
    attributes: attributesToOtlp(s.attributes),
    status: { code: s.status.code },
    events: [],
  };
  if (s.parentSpanId !== undefined) span.parentSpanId = ensureHex(s.parentSpanId, 16);
  if (s.status.message !== undefined) span.status.message = s.status.message;
  return span;
}

/**
 * Convert the actions of an AEP record into OTLP/JSON spans — one span per
 * action, all sharing the record's `run_id`-derived trace id. Exported so callers
 * (and tests) can inspect the span projection without going to the network.
 *
 * @param record  Any object structurally compatible with an AEP record.
 * @param runId   Override the trace-scoping run id (defaults to `record.run_id`).
 * @param traceId Override the trace id (defaults to `record.trace_id` then `runId`).
 */
export function aepRecordToOtlpSpans(
  record: { run_id: string; trace_id?: string | undefined; actions: ReadonlyArray<LooseAepAction> },
  runId?: string,
  traceId?: string
): OtlpSpan[] {
  const rid = runId ?? record.run_id;
  const tid = traceId ?? record.trace_id;
  return record.actions.map((action) =>
    // Narrow to AepActionLike at the bridge boundary (see LooseAepAction doc).
    otelSpanToOtlp(aepActionToOtelSpan(action as AepActionLike, rid, tid))
  );
}

function buildTracesPayload(
  record: { run_id: string; trace_id?: string | undefined; actions: ReadonlyArray<LooseAepAction> },
  serviceName: string,
  resourceAttributes: Record<string, string>
): {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{ scope: { name: string; version: string }; spans: OtlpSpan[] }>;
  }>;
} {
  const resourceAttrs: OtlpKeyValue[] = [
    { key: "service.name", value: { stringValue: serviceName } },
  ];
  for (const [k, v] of Object.entries(resourceAttributes)) {
    resourceAttrs.push({ key: k, value: { stringValue: v } });
  }
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [
          {
            scope: { name: "@wasmagent/aep", version: "0.2" },
            spans: aepRecordToOtlpSpans(record),
          },
        ],
      },
    ],
  };
}

function toOtlpValue(v: AttributeValue): OtlpAnyValue {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number")
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toOtlpValue) } };
  return { stringValue: String(v) };
}

function attributesToOtlp(attrs: Record<string, AttributeValue>): OtlpKeyValue[] {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ({ key: k, value: toOtlpValue(v) }));
}

/**
 * Ensure a W3C-valid hex ID of the expected length. Strips non-hex chars and
 * pads/truncates as a last resort so legacy or non-conforming ids still export.
 * (Mirrors the helper in `index.ts` for the span exporter.)
 */
function ensureHex(id: string, targetLen: number): string {
  if (id.length === targetLen && /^[0-9a-f]+$/.test(id)) return id;
  const stripped = id.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (stripped.length === 0) return "0".repeat(targetLen);
  return stripped.padStart(targetLen, "0").slice(-targetLen);
}

/**
 * OtlpEvidenceTransport — streams AEP evidence records to an OTLP/HTTP collector
 * as trace spans.
 *
 * For each published event the transport converts the record's actions into
 * OTLP spans and POSTs them to `<endpoint>/v1/traces`. Failed exports are
 * retried with exponential backoff (network errors + HTTP 5xx); HTTP 4xx
 * failures are not retried. Delivery is best-effort: a failing export is counted
 * in {@link failedCount} (and surfaced via {@link lastError}) and never throws,
 * so it cannot abort the surrounding `EvidencePublisher` fan-out — matching the
 * `StreamTransportOutbound` contract used by the other evidence transports.
 */
export class OtlpEvidenceTransport implements StreamTransportOutbound {
  readonly name = "otlp";
  readonly #endpoint: string;
  readonly #headers: Record<string, string>;
  readonly #serviceName: string;
  readonly #resourceAttributes: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number;
  readonly #fetcher: typeof fetch | undefined;
  #sent = 0;
  #failed = 0;
  #lastError: unknown = null;

  constructor(options: OtlpEvidenceTransportOptions = {}) {
    const base = (options.endpoint ?? "http://localhost:4318").replace(/\/$/, "");
    this.#endpoint = `${base}/v1/traces`;
    this.#headers = { "Content-Type": "application/json", ...options.headers };
    this.#serviceName = options.serviceName ?? "wasmagent";
    this.#resourceAttributes = options.resourceAttributes ?? {};
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#retryDelayMs = options.retryDelayMs ?? 1000;
    this.#fetcher = options.fetcher;
  }

  /** Resolve the fetch implementation (explicit override, else the global at call time). */
  #resolveFetcher(): typeof fetch {
    return this.#fetcher ?? fetch;
  }

  /** Number of records successfully exported (HTTP 2xx). */
  get sentCount(): number {
    return this.#sent;
  }

  /** Number of records that failed export after all retries. */
  get failedCount(): number {
    return this.#failed;
  }

  /** The most recent export error, if any (null otherwise). */
  get lastError(): unknown {
    return this.#lastError;
  }

  /** StreamTransportOutbound: convert + POST one event. Best-effort, never throws. */
  async send(event: StreamEvent): Promise<void> {
    const body = buildTracesPayload(event.record, this.#serviceName, this.#resourceAttributes);
    try {
      await this.#postWithRetry(body);
      this.#sent++;
    } catch (err) {
      // Best-effort: a failing collector is observable but must not abort the
      // surrounding publish fan-out (StreamTransportOutbound contract).
      this.#lastError = err;
      this.#failed++;
    }
  }

  /** POST the OTLP traces payload with exponential-backoff retry. */
  async #postWithRetry(body: object): Promise<void> {
    let lastError: Error | undefined;
    let delay = this.#retryDelayMs;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      let res: Response;
      try {
        res = await this.#resolveFetcher()(this.#endpoint, {
          method: "POST",
          headers: this.#headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        // Network error / abort → retryable.
        lastError =
          (err as Error)?.name === "AbortError"
            ? new Error("OTLP evidence export timed out")
            : err instanceof Error
              ? err
              : new Error(String(err));
        continue;
      }
      clearTimeout(timer);
      if (res.ok) return;
      if (res.status >= 400 && res.status < 500) {
        // 4xx client errors are not retryable — surface and stop.
        const t = await res.text().catch(() => "");
        throw new Error(`OTLP evidence export HTTP ${res.status}: ${t.slice(0, 200)}`);
      }
      // 5xx → retryable.
      lastError = new Error(`OTLP evidence export HTTP ${res.status} (retrying)`);
    }
    throw lastError ?? new Error("OTLP evidence export failed");
  }
}
