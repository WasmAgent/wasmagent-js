import type { EvidenceStoreQuery } from "./evidenceStore.js";
import { matchesFilter } from "./evidenceStore.js";
import {
  EvidenceStream,
  type EvidenceStreamOptions,
  type StreamEvent,
  type StreamPublishResult,
  type StreamSubscriber,
  type StreamTransportOutbound,
} from "./evidenceStream.js";
import type { AEPRecord, SideEffectClass } from "./types.js";

/**
 * evidenceMonitor.ts — real-time evidence monitoring hooks (Milestone 6, #265).
 *
 * Built on top of {@link EvidenceStream}'s generic pub/sub primitives, this
 * module provides three concrete, ready-to-use **monitoring hooks** for
 * compliance dashboards and external auditors:
 *
 * 1. **Webhook subscriptions** ({@link WebhookMonitorHook}) — POST each
 *    evidence event to one or more HTTPS webhook URLs, with HMAC-SHA-256
 *    signing, exponential-backoff retries, SSRF protection, and an optional
 *    dead-letter backend for persistently failed deliveries.
 * 2. **WebSocket streaming** ({@link WebSocketMonitorHook}) — serialize each
 *    evidence event onto a WebSocket-like connection so live dashboards get a
 *    push feed without polling.
 * 3. **In-process observers** ({@link ComplianceDashboardObserver}) —
 *    aggregate matching events into a rolling snapshot (counts by run, tool,
 *    side-effect class, and model) that compliance dashboards read
 *    synchronously, plus a configurable callback for custom reactions.
 *
 * {@link EvidenceMonitor} ties all three hook types to a single
 * {@link EvidenceStream} for ergonomic lifecycle management.
 *
 * @example
 * ```ts
 * import { EvidenceMonitor } from "@wasmagent/aep";
 *
 * const monitor = new EvidenceMonitor({ topic: "compliance-feed" });
 *
 * // In-process dashboard observer
 * const dashboard = monitor.observe({ windowSize: 50 });
 *
 * // Webhook subscription (auditor endpoint)
 * monitor.addWebhook({ urls: ["https://audit.example.com/evidence"], secret: "s" });
 *
 * // WebSocket streaming (live UI)
 * monitor.addWebSocket({ socket: ws });
 *
 * await monitor.publish(record);
 * console.log(dashboard.snapshot.totalEvents); // 1
 * ```
 */

const ALL_SIDE_EFFECT_CLASSES: readonly SideEffectClass[] = [
  "read",
  "mutate-local",
  "mutate-external",
  "network-egress",
  "unknown",
];

/** Standard WebSocket readyState value for an OPEN connection. */
const WS_OPEN = 1;

/** Patterns describing private/internal host ranges blocked from webhook delivery (SSRF guard). */
const BLOCKED_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

/**
 * Validate a webhook URL: must be `https://` and must not resolve to a
 * private/internal network range. Throws on violation. Shared SSRF guard for
 * all outbound webhook delivery in this module.
 */
export function validateWebhookUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid webhook URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Webhook URL must use https:// — got: ${rawUrl}`);
  }
  for (const pattern of BLOCKED_HOST_PATTERNS) {
    if (pattern.test(parsed.hostname)) {
      throw new Error(`Webhook URL points to a private/internal address — blocked: ${rawUrl}`);
    }
  }
}

/** Minimal backend for persisting dead-letter webhook deliveries. */
export interface DeadLetterBackend {
  put(key: string, value: string): Promise<void> | void;
}

/** Per-URL result of one webhook fan-out. */
export interface WebhookDeliveryResult {
  /** Target URL. */
  readonly url: string;
  /** Whether the final attempt succeeded (HTTP 2xx). */
  readonly ok: boolean;
  /** Number of attempts made. */
  readonly attempts: number;
  /** Final HTTP status code, if a response was received. */
  readonly status?: number;
  /** Final error message, if delivery failed. */
  readonly error?: string;
}

/** Options for {@link WebhookMonitorHook} / {@link EvidenceMonitor.addWebhook}. */
export interface WebhookHookOptions {
  /** Transport name (default `webhook`). */
  readonly name?: string;
  /** HTTPS webhook endpoint URLs. Validated up front for SSRF safety. */
  readonly urls: string[];
  /** Optional HMAC-SHA-256 secret. When set, each payload is signed and the
   *  digest sent as `X-Wasmagent-Signature: sha256=<hex>`. */
  readonly secret?: string;
  /** Max retry attempts per URL (default 3). */
  readonly maxRetries?: number;
  /** When provided, deliveries that exhaust retries are persisted here. */
  readonly dlqBackend?: DeadLetterBackend;
  /** Override `fetch` (for tests and non-browser runtimes). Defaults to global `fetch`. */
  readonly fetcher?: typeof fetch;
  /** Only deliver events whose record matches this filter. */
  readonly filter?: EvidenceStoreQuery;
  /** Customize the JSON payload sent per event. Defaults to {@link defaultWebhookPayload}. */
  readonly payloadFor?: (event: StreamEvent) => unknown;
  /** Exponential backoff base in ms (default 200 → 200, 400, 800...). */
  readonly backoffMs?: number;
}

const HMAC_HEADER = "X-Wasmagent-Signature";

async function hmacSign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `sha256=${hex}`;
}

async function shortHash(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(buf).slice(0, 6);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Default webhook payload: stream metadata plus a few top-level record fields
 * for easy routing, with the full record nested under `record`.
 */
export function defaultWebhookPayload(event: StreamEvent): Record<string, unknown> {
  const { record } = event;
  return {
    topic: event.topic,
    sequence: event.sequence,
    publishedAtMs: event.publishedAtMs,
    run_id: record.run_id,
    model_id: record.model_id,
    created_at_ms: record.created_at_ms,
    record,
  };
}

function emptySideEffectCounts(): Record<SideEffectClass, number> {
  return { read: 0, "mutate-local": 0, "mutate-external": 0, "network-egress": 0, unknown: 0 };
}

/**
 * WebhookMonitorHook — webhook subscription transport for an {@link EvidenceStream}.
 *
 * For each published event (optionally filtered), POSTs a JSON payload to every
 * configured URL with HMAC signing, exponential-backoff retries, and an optional
 * dead-letter backend. SSRF protection runs at construction time, so an invalid
 * URL fails fast before any network access.
 *
 * Delivery is best-effort: partial failures are recorded in {@link lastResults}
 * (and optionally the DLQ) and never abort the surrounding publish fan-out.
 */
export class WebhookMonitorHook implements StreamTransportOutbound {
  readonly name: string;
  readonly #urls: string[];
  readonly #secret: string | undefined;
  readonly #maxRetries: number;
  readonly #dlqBackend: DeadLetterBackend | undefined;
  readonly #fetcher: typeof fetch;
  readonly #filter: EvidenceStoreQuery | undefined;
  readonly #payloadFor: (event: StreamEvent) => unknown;
  readonly #backoffMs: number;
  #lastResults: ReadonlyArray<WebhookDeliveryResult> = [];

  constructor(options: WebhookHookOptions) {
    if (options.urls.length === 0) {
      throw new Error("WebhookMonitorHook requires at least one URL");
    }
    // Validate every URL up front (SSRF guard) — fail fast on construction.
    for (const url of options.urls) validateWebhookUrl(url);
    this.name = options.name ?? "webhook";
    this.#urls = [...options.urls];
    this.#secret = options.secret;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#dlqBackend = options.dlqBackend;
    this.#fetcher = options.fetcher ?? fetch;
    this.#filter = options.filter;
    this.#payloadFor = options.payloadFor ?? defaultWebhookPayload;
    this.#backoffMs = options.backoffMs ?? 200;
  }

  /** Per-URL delivery results from the most recent {@link send} call. */
  get lastResults(): ReadonlyArray<WebhookDeliveryResult> {
    return this.#lastResults;
  }

  async send(event: StreamEvent): Promise<void> {
    if (this.#filter !== undefined && !matchesFilter(event.record, this.#filter)) return;

    const payload = this.#payloadFor(event);
    const body = JSON.stringify(payload);
    const results: WebhookDeliveryResult[] = [];

    for (const url of this.#urls) {
      const result = await this.#deliverOne(url, body);
      results.push(result);
      if (!result.ok && this.#dlqBackend) {
        const urlHash = await shortHash(url);
        await this.#dlqBackend.put(
          `dlq:${event.topic}:${event.sequence}:${urlHash}`,
          JSON.stringify({ payload, ...result })
        );
      }
    }
    this.#lastResults = results;
  }

  async #deliverOne(url: string, body: string): Promise<WebhookDeliveryResult> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.#secret !== undefined) headers[HMAC_HEADER] = await hmacSign(this.#secret, body);

    let attempts = 0;
    let lastStatus: number | undefined;
    let lastError: string | undefined;

    while (attempts < this.#maxRetries) {
      attempts++;
      try {
        const resp = await this.#fetcher(url, { method: "POST", headers, body });
        if (resp.ok) return { url, ok: true, attempts, status: resp.status };
        lastStatus = resp.status;
        lastError = `HTTP ${resp.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempts < this.#maxRetries) {
        await new Promise((r) => setTimeout(r, this.#backoffMs * 2 ** (attempts - 1)));
      }
    }

    return {
      url,
      ok: false,
      attempts,
      ...(lastStatus !== undefined ? { status: lastStatus } : {}),
      ...(lastError !== undefined ? { error: lastError } : {}),
    };
  }
}

/** Minimal surface of a WebSocket this hook drives. */
export interface WebSocketLike {
  /** Current readyState; `1` (or {@link WebSocketHookOptions.openReadyState}) means OPEN. */
  readonly readyState: number;
  /** Queue a message for delivery. May throw if the socket is not open. */
  send(data: string): void;
  /** Begin a graceful close. */
  close(code?: number, reason?: string): void;
}

/** Options for {@link WebSocketMonitorHook} / {@link EvidenceMonitor.addWebSocket}. */
export interface WebSocketHookOptions {
  /** Transport name (default `websocket`). */
  readonly name?: string;
  /** The connected (or connecting) WebSocket-like object to stream onto. */
  readonly socket: WebSocketLike;
  /** readyState value indicating OPEN (default `1`, the WebSocket standard). */
  readonly openReadyState?: number;
  /** Only stream events whose record matches this filter. */
  readonly filter?: EvidenceStoreQuery;
  /** Custom serializer (default `JSON.stringify(event)`). */
  readonly serialize?: (event: StreamEvent) => string;
}

/**
 * WebSocketMonitorHook — WebSocket streaming transport for an {@link EvidenceStream}.
 *
 * Serializes each published event (optionally filtered) onto a WebSocket-like
 * connection. Events arriving while the socket is not yet open are counted as
 * dropped (never thrown) so a slow-connecting dashboard never blocks evidence
 * delivery to other hooks. Surfaced via {@link droppedCount}.
 */
export class WebSocketMonitorHook implements StreamTransportOutbound {
  readonly name: string;
  readonly #socket: WebSocketLike;
  readonly #openReadyState: number;
  readonly #filter: EvidenceStoreQuery | undefined;
  readonly #serialize: (event: StreamEvent) => string;
  #sentCount = 0;
  #droppedCount = 0;
  #lastError: unknown = null;

  constructor(options: WebSocketHookOptions) {
    this.name = options.name ?? "websocket";
    this.#socket = options.socket;
    this.#openReadyState = options.openReadyState ?? WS_OPEN;
    this.#filter = options.filter;
    this.#serialize = options.serialize ?? ((event) => JSON.stringify(event));
  }

  /** Number of events successfully handed to `socket.send`. */
  get sentCount(): number {
    return this.#sentCount;
  }

  /** Number of events dropped because the socket was not open. */
  get droppedCount(): number {
    return this.#droppedCount;
  }

  /** The most recent error thrown by `socket.send`, if any (null otherwise). */
  get lastError(): unknown {
    return this.#lastError;
  }

  send(event: StreamEvent): void {
    if (this.#filter !== undefined && !matchesFilter(event.record, this.#filter)) return;
    if (this.#socket.readyState !== this.#openReadyState) {
      this.#droppedCount++;
      return;
    }
    try {
      this.#socket.send(this.#serialize(event));
      this.#sentCount++;
    } catch (err) {
      // Best-effort: a failing send is observable but never aborts the fan-out.
      this.#lastError = err;
      this.#droppedCount++;
    }
  }

  close(): void {
    try {
      this.#socket.close();
    } catch {
      // Best-effort cleanup.
    }
  }
}

/** Aggregate snapshot consumed by compliance dashboards. */
export interface ComplianceDashboardSnapshot {
  /** Total number of matching events observed. */
  readonly totalEvents: number;
  /** Total number of actions across all observed records. */
  readonly totalActions: number;
  /** Event counts grouped by `run_id`. */
  readonly byRunId: Readonly<Record<string, number>>;
  /** Action counts grouped by `tool_name` (summed across records). */
  readonly byTool: Readonly<Record<string, number>>;
  /** Action counts grouped by `side_effect_class` (always all five keys). */
  readonly bySideEffectClass: Readonly<Record<SideEffectClass, number>>;
  /** Event counts grouped by `model_id` (omits records with no model). */
  readonly byModelId: Readonly<Record<string, number>>;
  /** Rolling window of recent events (oldest first, most recent last). */
  readonly recent: ReadonlyArray<StreamEvent>;
  /** Timestamp (ms) of the first observed event, or null if none. */
  readonly firstSeenMs: number | null;
  /** Timestamp (ms) of the most recent observed event, or null if none. */
  readonly lastSeenMs: number | null;
}

/** Options for {@link ComplianceDashboardObserver} / {@link EvidenceMonitor.observe}. */
export interface ComplianceObserverOptions {
  /** Only aggregate events whose record matches this filter. */
  readonly filter?: EvidenceStoreQuery;
  /** Number of recent events to retain in {@link ComplianceDashboardSnapshot.recent} (default 100). */
  readonly windowSize?: number;
  /** Optional callback invoked for each matching event, in addition to aggregation. */
  readonly onEvent?: (event: StreamEvent) => void;
}

/**
 * ComplianceDashboardObserver — in-process observer that aggregates evidence
 * events into a dashboard snapshot.
 *
 * Pass {@link handle} to {@link EvidenceStream.subscribe} (the observer applies
 * its own filter internally). Dashboards read {@link snapshot} synchronously to
 * render live counts by run, tool, side-effect class, and model, plus a rolling
 * recent-events window.
 */
export class ComplianceDashboardObserver {
  readonly #filter: EvidenceStoreQuery | undefined;
  readonly #windowSize: number;
  readonly #onEvent: ((event: StreamEvent) => void) | undefined;
  #totalEvents = 0;
  #totalActions = 0;
  #byRunId: Record<string, number> = {};
  #byTool: Record<string, number> = {};
  #bySideEffectClass: Record<SideEffectClass, number> = emptySideEffectCounts();
  #byModelId: Record<string, number> = {};
  #recent: StreamEvent[] = [];
  #firstSeenMs: number | null = null;
  #lastSeenMs: number | null = null;

  constructor(options: ComplianceObserverOptions = {}) {
    this.#filter = options.filter;
    this.#windowSize = options.windowSize ?? 100;
    this.#onEvent = options.onEvent;
  }

  /**
   * Subscriber callback compatible with {@link EvidenceStream.subscribe}.
   * Applies the configured filter, then updates the aggregate snapshot.
   */
  readonly handle: StreamSubscriber = (event: StreamEvent): void => {
    if (this.#filter !== undefined && !matchesFilter(event.record, this.#filter)) return;
    this.#ingest(event);
    if (this.#onEvent !== undefined) this.#onEvent(event);
  };

  /** Current aggregate snapshot (a defensive copy of the recent window). */
  get snapshot(): ComplianceDashboardSnapshot {
    return {
      totalEvents: this.#totalEvents,
      totalActions: this.#totalActions,
      byRunId: { ...this.#byRunId },
      byTool: { ...this.#byTool },
      bySideEffectClass: { ...this.#bySideEffectClass },
      byModelId: { ...this.#byModelId },
      recent: this.#recent.slice(),
      firstSeenMs: this.#firstSeenMs,
      lastSeenMs: this.#lastSeenMs,
    };
  }

  /** Reset all aggregates and the recent window. */
  reset(): void {
    this.#totalEvents = 0;
    this.#totalActions = 0;
    this.#byRunId = {};
    this.#byTool = {};
    this.#bySideEffectClass = emptySideEffectCounts();
    this.#byModelId = {};
    this.#recent = [];
    this.#firstSeenMs = null;
    this.#lastSeenMs = null;
  }

  #ingest(event: StreamEvent): void {
    const { record } = event;
    this.#totalEvents++;
    this.#totalActions += record.actions.length;
    this.#bump(this.#byRunId, record.run_id);
    if (record.model_id !== undefined) this.#bump(this.#byModelId, record.model_id);
    for (const action of record.actions) {
      this.#bump(this.#byTool, action.tool_name);
      this.#bump(this.#bySideEffectClass, action.side_effect_class);
    }
    this.#recent.push(event);
    if (this.#recent.length > this.#windowSize) {
      this.#recent.splice(0, this.#recent.length - this.#windowSize);
    }
    if (this.#firstSeenMs === null) this.#firstSeenMs = event.publishedAtMs;
    this.#lastSeenMs = event.publishedAtMs;
  }

  #bump(map: Record<string, number>, key: string): void {
    map[key] = (map[key] ?? 0) + 1;
  }
}

/** Options for {@link EvidenceMonitor}. */
export interface EvidenceMonitorOptions extends EvidenceStreamOptions {
  /** Wrap an existing stream instead of creating a new one. */
  readonly stream?: EvidenceStream;
}

/**
 * EvidenceMonitor — convenience container wiring webhook, WebSocket, and
 * in-process observer hooks onto a single {@link EvidenceStream}.
 *
 * Provides ergonomic {@link addWebhook}, {@link addWebSocket}, and
 * {@link observe} factories plus a single {@link close} that tears down every
 * attached hook via the underlying stream.
 */
export class EvidenceMonitor {
  readonly #stream: EvidenceStream;
  readonly #hooks: StreamTransportOutbound[] = [];
  readonly #observers: ComplianceDashboardObserver[] = [];

  constructor(options: EvidenceMonitorOptions = {}) {
    const { stream, ...streamOptions } = options;
    this.#stream = stream ?? new EvidenceStream(streamOptions);
  }

  /** The underlying stream records are published onto. */
  get stream(): EvidenceStream {
    return this.#stream;
  }

  /** The stream's topic identifier. */
  get topic(): string {
    return this.#stream.topic;
  }

  /** Number of attached transport hooks (webhook + WebSocket). */
  get hookCount(): number {
    return this.#hooks.length;
  }

  /** Number of attached in-process observers. */
  get observerCount(): number {
    return this.#observers.length;
  }

  /** Attach a webhook subscription hook and register it on the stream. */
  addWebhook(options: WebhookHookOptions): WebhookMonitorHook {
    const hook = new WebhookMonitorHook(options);
    this.#stream.addTransport(hook);
    this.#hooks.push(hook);
    return hook;
  }

  /** Attach a WebSocket streaming hook and register it on the stream. */
  addWebSocket(options: WebSocketHookOptions): WebSocketMonitorHook {
    const hook = new WebSocketMonitorHook(options);
    this.#stream.addTransport(hook);
    this.#hooks.push(hook);
    return hook;
  }

  /** Attach an in-process compliance dashboard observer. */
  observe(options: ComplianceObserverOptions = {}): ComplianceDashboardObserver {
    const observer = new ComplianceDashboardObserver(options);
    this.#stream.subscribe(observer.handle);
    this.#observers.push(observer);
    return observer;
  }

  /** Publish a record to the underlying stream (fans out to all hooks/observers). */
  async publish(record: AEPRecord): Promise<StreamPublishResult> {
    return this.#stream.publish(record);
  }

  /** Close the underlying stream, tearing down every attached hook. */
  async close(): Promise<void> {
    await this.#stream.close();
  }
}

// Side-effect-class list re-exported for consumers that want to iterate the
// canonical class set (e.g. to render a full dashboard table).
export { ALL_SIDE_EFFECT_CLASSES as SIDE_EFFECT_CLASSES };
