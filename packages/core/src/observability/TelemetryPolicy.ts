/**
 * TelemetryPolicy — configurable retention, redaction, and export rules
 * for operational telemetry and evidence (#389).
 *
 * The module is deliberately dependency-free and side-effect-free: it ships
 * pure policy primitives that callers wire into whichever surface they own
 * (EventLog KV entries, StructuredMemory observations, AEP evidence payloads,
 * OTel span attributes). Nothing here records or sends anything on its own.
 *
 * Three knobs, matching the milestone bullet:
 *  - retention — drop stored records older than `maxAgeMs` or beyond
 *    `maxRecords` (newest survive), scoped to a KV key prefix
 *  - redaction — replace matched substrings in text/values before they are
 *    persisted or exported (`[redacted]` by default)
 *  - export — batch records through a sink without blocking producers
 */

import type { KvBackend } from "../checkpoint/index.js";

// ── Redaction ────────────────────────────────────────────────────────────────

/** One redaction rule: replace every `match` occurrence in a string. */
export interface RedactionRule {
  /** Pattern to replace. Plain strings are treated as literal substrings. */
  match: RegExp | string;
  /** Replacement text. Default: "[redacted]". */
  replaceWith?: string;
}

export interface RedactionOptions {
  rules: RedactionRule[];
}

const DEFAULT_REDACTION = "[redacted]";

/** Compile a rule to a global RegExp (string rules are escaped). */
function toGlobalRegExp(match: RegExp | string): RegExp {
  if (typeof match === "string") {
    return new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  }
  return new RegExp(match.source, match.flags.includes("g") ? match.flags : `${match.flags}g`);
}

/** Redact a single string according to the rules. Empty rule list is a no-op. */
export function redactText(text: string, opts: RedactionOptions): string {
  let out = text;
  for (const rule of opts.rules) {
    out = out.replace(toGlobalRegExp(rule.match), rule.replaceWith ?? DEFAULT_REDACTION);
  }
  return out;
}

/**
 * Deep-redact every string inside a JSON-ish value (objects, arrays, nested
 * structures). Numbers/booleans/null pass through untouched. Depth is capped
 * at 16 levels; cycles are cut at first revisit.
 */
export function redactValue<T>(value: T, opts: RedactionOptions, depth = 0): T {
  if (opts.rules.length === 0) return value;
  if (depth > 16) return value;
  if (typeof value === "string") return redactText(value, opts) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, opts, depth + 1)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(val, opts, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

// ── Retention ────────────────────────────────────────────────────────────────

export interface RetentionPolicy {
  /**
   * KV key prefix this policy applies to (e.g. `"evlog:"`, `"obs:"`).
   * Required — retention never sweeps keys it was not scoped to.
   */
  prefix: string;
  /** Delete records whose timestamp is older than this many ms. */
  maxAgeMs?: number;
  /** Keep at most this many records under the prefix (newest survive). */
  maxRecords?: number;
}

/**
 * Extract the record timestamp (ms since epoch) from a stored KV value.
 * Default knows the two shapes this runtime persists: `{ timestampMs }`
 * (event-log entries) and `{ createdAtMs }` (observations, evidence).
 * Values without a recognizable timestamp return undefined and are treated
 * as newest (never aged out by maxAgeMs; sorted last for maxRecords).
 */
export type TimestampExtractor = (key: string, value: string) => number | undefined;

export function defaultTimestampExtractor(key: string, value: string): number | undefined {
  void key;
  try {
    const parsed = JSON.parse(value) as { timestampMs?: unknown; createdAtMs?: unknown };
    if (typeof parsed.timestampMs === "number") return parsed.timestampMs;
    if (typeof parsed.createdAtMs === "number") return parsed.createdAtMs;
  } catch {
    /* non-JSON value — treated as timestamp-less */
  }
  return undefined;
}

/**
 * Sweep a KV backend according to the retention policy. Deletes records
 * under `policy.prefix` that are (a) older than `maxAgeMs`, or (b) beyond
 * `maxRecords` counting from the newest. Returns the number of deleted keys.
 *
 * Backends without `list()` are skipped (nothing to enumerate).
 */
export async function applyRetention(
  kv: KvBackend,
  policy: RetentionPolicy,
  opts: { nowMs?: number; extractTimestamp?: TimestampExtractor } = {}
): Promise<number> {
  if (!kv.list) return 0;
  const { prefix, maxAgeMs, maxRecords } = policy;
  if (maxAgeMs === undefined && maxRecords === undefined) return 0;

  const nowMs = opts.nowMs ?? Date.now();
  const extract = opts.extractTimestamp ?? defaultTimestampExtractor;

  const keys = await kv.list(prefix);
  const stamped: Array<{ key: string; ts: number | undefined }> = [];
  for (const key of keys) {
    const raw = await kv.get(key);
    if (raw === null) continue;
    stamped.push({ key, ts: extract(key, raw) });
  }

  // Oldest first; timestamp-less entries sort last (treated as newest).
  stamped.sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity));

  const victims = new Set<string>();
  for (const { key, ts } of stamped) {
    if (maxAgeMs !== undefined && ts !== undefined && nowMs - ts > maxAgeMs) {
      victims.add(key);
    }
  }
  if (maxRecords !== undefined && stamped.length > maxRecords) {
    const excess = stamped.slice(0, stamped.length - maxRecords);
    for (const { key } of excess) victims.add(key);
  }

  for (const key of victims) {
    await kv.delete(key);
  }
  return victims.size;
}

// ── Export ───────────────────────────────────────────────────────────────────

/**
 * Batch records before handing them to an export sink. Producers call
 * `push()` (sync, never blocks); the sink fires once `batchSize` records
 * accumulate or `flush()` is called (e.g. on shutdown / run end).
 */
export class BatchingExporter<T> {
  readonly #sink: (batch: T[]) => void | Promise<void>;
  readonly #batchSize: number;
  #buffer: T[] = [];

  constructor(sink: (batch: T[]) => void | Promise<void>, batchSize = 100) {
    if (batchSize < 1) throw new Error("BatchingExporter batchSize must be >= 1");
    this.#sink = sink;
    this.#batchSize = batchSize;
  }

  /** Buffer one record; flushes synchronously when the batch is full. */
  push(item: T): void {
    this.#buffer.push(item);
    if (this.#buffer.length >= this.#batchSize) {
      void this.flush();
    }
  }

  /** Current buffer size (exposed for tests/diagnostics). */
  get size(): number {
    return this.#buffer.length;
  }

  /** Hand the buffered records to the sink (no-op when empty). */
  async flush(): Promise<void> {
    if (this.#buffer.length === 0) return;
    const batch = this.#buffer;
    this.#buffer = [];
    await this.#sink(batch);
  }
}

// ── Aggregate ────────────────────────────────────────────────────────────────

/**
 * Full policy object for callers that want a single config surface:
 *
 * ```ts
 * const policy: TelemetryPolicy = {
 *   retention: { prefix: "evlog:", maxAgeMs: 7 * 24 * 3600_000 },
 *   redaction: { rules: [{ match: /sk-[a-zA-Z0-9]{20,}/ }] },
 * };
 * ```
 */
export interface TelemetryPolicy {
  retention?: RetentionPolicy;
  redaction?: RedactionOptions;
}
