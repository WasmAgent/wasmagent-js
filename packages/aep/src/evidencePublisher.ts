import type { EvidenceStore, EvidenceStoreQuery } from "./evidenceStore.js";
import { matchesFilter } from "./evidenceStore.js";
import {
  EvidenceStream,
  type EvidenceStreamOptions,
  type StreamPublishResult,
  type StreamSubscriber,
  type StreamSubscription,
  type StreamTransportOutbound,
} from "./evidenceStream.js";
import type { AEPRecord } from "./types.js";

/**
 * evidencePublisher.ts — real-time evidence streaming for live monitoring
 * dashboards and external observability pipelines (Milestone 7, #276).
 *
 * An {@link EvidencePublisher} is the top-level real-time streaming surface for
 * AEP evidence. It wraps an {@link EvidenceStream} and adds two capabilities the
 * bare stream does not provide:
 *
 * 1. **Live monitoring of a store** — when given an {@link EvidenceStore},
 *    {@link start} polls it on a fixed cadence and streams every record appended
 *    *after* the publisher started watching. This turns a durable, append-only
 *    evidence store into a live feed for monitoring dashboards without the
 *    emitters having to know about the stream.
 * 2. **External observability pipelines** — pluggable {@link StreamTransportOutbound}
 *    transports fan each record out to any backend. The companion
 *    `@wasmagent/otel-exporter` package ships an `OtlpEvidenceTransport` that
 *    converts each record's actions into OTLP trace spans and POSTs them to any
 *    OTLP-compatible collector (Jaeger, Tempo, Datadog, …) — the OpenTelemetry
 *    integration called out by the milestone bullet.
 *
 * ## Two ways to feed the publisher
 *
 * - **Push mode** — call {@link publish} directly for each record as it is
 *   produced (lowest latency; the emitter drives the stream).
 * - **Watch mode** — construct with a `store` and call {@link start}; the
 *   publisher polls the store and publishes new records itself (decouples
 *   emitters from the stream; ideal for retrofitting live dashboards onto an
 *   existing evidence store).
 *
 * Both modes fan out through the same underlying {@link EvidenceStream}, so
 * every attached subscriber and transport sees every published record.
 *
 * Delivery is best-effort and fail-soft: a failing subscriber or transport is
 * isolated (captured in the per-publish {@link StreamPublishResult.errors}) and
 * never aborts delivery to the others, and store-watch polling errors are
 * counted in {@link EvidencePublisherStats.errors} without stopping the loop.
 *
 * @example Push mode + OpenTelemetry transport
 * ```ts
 * import { EvidencePublisher } from "@wasmagent/aep";
 * import { OtlpEvidenceTransport } from "@wasmagent/otel-exporter";
 *
 * const publisher = new EvidencePublisher({ topic: "live-evidence" });
 * publisher.addTransport(new OtlpEvidenceTransport({ endpoint: "http://collector:4318" }));
 * publisher.subscribe((event) => dashboard.render(event.record));
 *
 * await publisher.publish(record); // → subscriber + OTLP collector both receive it
 * await publisher.close();
 * ```
 *
 * @example Watch mode (live dashboard over an existing store)
 * ```ts
 * import { EvidencePublisher, InMemoryEvidenceStore } from "@wasmagent/aep";
 *
 * const store = new InMemoryEvidenceStore();
 * const publisher = new EvidencePublisher({ store, pollIntervalMs: 500 });
 * publisher.subscribe((event) => console.log("new evidence:", event.record.run_id));
 * await publisher.start(); // initial poll, then every 500ms
 * // ...other code appends to `store`; the subscriber fires for each new record...
 * publisher.stop();
 * ```
 */

/** Options for constructing an {@link EvidencePublisher}. */
export interface EvidencePublisherOptions extends EvidenceStreamOptions {
  /**
   * Wrap an existing {@link EvidenceStream} instead of creating a new one. When
   * supplied, the `topic` / `replayBufferSize` options are ignored.
   */
  readonly stream?: EvidenceStream;
  /**
   * Optional {@link EvidenceStore} to watch. When set, {@link start} polls the
   * store every {@link pollIntervalMs} and publishes records appended after the
   * publisher began watching. Records that do not match {@link filter} are
   * skipped (counted in {@link EvidencePublisherStats.filtered}).
   */
  readonly store?: EvidenceStore;
  /** Polling interval for store-watching, in milliseconds. Default: `1000`. */
  readonly pollIntervalMs?: number;
  /**
   * Content filter applied to records pulled from the watched store. Only
   * matching records are published. Reuses {@link EvidenceStoreQuery} semantics.
   * Does not affect records pushed directly via {@link publish}.
   */
  readonly filter?: EvidenceStoreQuery;
}

/** Lifecycle counters exposed by {@link EvidencePublisher.stats}. */
export interface EvidencePublisherStats {
  /** Records successfully streamed (pushed or pulled from the store). */
  readonly published: number;
  /** Store-watched records skipped because they did not match {@link filter}. */
  readonly filtered: number;
  /** Total per-target delivery errors observed across all publishes. */
  readonly errors: number;
  /** Number of store polls completed since {@link start}. */
  readonly storePolled: number;
}

/**
 * EvidencePublisher — real-time AEP evidence streaming for live monitoring
 * dashboards and external observability pipelines.
 *
 * See the module doc for the full push/watch-mode overview. Use {@link publish}
 * for direct streaming, {@link subscribe} / {@link addTransport} to attach live
 * dashboards and OTel/webhook/WebSocket sinks, and {@link start} / {@link stop}
 * to drive the stream from a watched {@link EvidenceStore}.
 */
export class EvidencePublisher {
  readonly #stream: EvidenceStream;
  readonly #store: EvidenceStore | undefined;
  readonly #pollIntervalMs: number;
  readonly #filter: EvidenceStoreQuery | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling = false;
  #lastSeenIndex = 0;
  #published = 0;
  #filtered = 0;
  #errors = 0;
  #storePolled = 0;
  #closed = false;

  constructor(options: EvidencePublisherOptions = {}) {
    const { stream, store, pollIntervalMs, filter, ...streamOptions } = options;
    this.#stream = stream ?? new EvidenceStream(streamOptions);
    this.#store = store;
    this.#pollIntervalMs = pollIntervalMs ?? 1000;
    this.#filter = filter;
  }

  /** The underlying stream records are published onto. */
  get stream(): EvidenceStream {
    return this.#stream;
  }

  /** The stream's topic identifier. */
  get topic(): string {
    return this.#stream.topic;
  }

  /** Whether the store-watching loop is currently running. */
  get running(): boolean {
    return this.#timer !== undefined;
  }

  /** Whether the publisher has been closed. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Current lifecycle counters (a snapshot). */
  get stats(): EvidencePublisherStats {
    return {
      published: this.#published,
      filtered: this.#filtered,
      errors: this.#errors,
      storePolled: this.#storePolled,
    };
  }

  /**
   * Publish a single record in real time to every subscriber and transport
   * attached to the underlying stream. Returns the per-target delivery result.
   *
   * Records pushed this way bypass the {@link filter} — the caller already
   * chose the record. (The filter only gates records pulled from a watched
   * store.)
   *
   * @throws if the publisher has been closed.
   */
  async publish(record: AEPRecord): Promise<StreamPublishResult> {
    if (this.#closed) throw new Error("Cannot publish to a closed EvidencePublisher");
    try {
      const result = await this.#stream.publish(record);
      this.#published++;
      this.#errors += result.errors.length;
      return result;
    } catch (err) {
      this.#errors++;
      throw err;
    }
  }

  /**
   * Attach an in-process subscriber (e.g. a live dashboard renderer). If
   * `filter` is given, the subscriber only receives events whose record
   * matches it. Returns a handle for {@link unsubscribe}.
   */
  subscribe(callback: StreamSubscriber, filter?: EvidenceStoreQuery): StreamSubscription {
    return this.#stream.subscribe(callback, filter);
  }

  /** Cancel a subscription. Returns `true` if it was active. */
  unsubscribe(subscription: StreamSubscription | string): boolean {
    return this.#stream.unsubscribe(subscription);
  }

  /**
   * Register an outbound transport adapter (e.g. `OtlpEvidenceTransport`,
   * `WebhookMonitorHook`, `WebSocketMonitorHook`). The transport's `send()` is
   * invoked for every published event.
   */
  addTransport(transport: StreamTransportOutbound): void {
    this.#stream.addTransport(transport);
  }

  /** Remove an outbound transport by name. Returns `true` if found. */
  removeTransport(name: string): boolean {
    return this.#stream.removeTransport(name);
  }

  /**
   * Begin watching the configured store. Performs an immediate poll (so the
   * dashboard sees the store's current tail), then re-polls every
   * {@link pollIntervalMs}. Only records appended *after* the first poll are
   * streamed; the publisher never replays records that predate {@link start}.
   *
   * Re-entrant polls are skipped: if one poll is still in flight when the
   * interval fires, that tick is a no-op. Polling errors are counted in
   * {@link EvidencePublisherStats.errors} and never stop the loop.
   *
   * @throws if no `store` was configured or the publisher has been closed.
   */
  async start(): Promise<void> {
    if (this.#closed) throw new Error("Cannot start a closed EvidencePublisher");
    if (this.#store === undefined) {
      throw new Error(
        "EvidencePublisher.start() requires a store — pass `store` to the constructor"
      );
    }
    if (this.#timer !== undefined) return; // already running

    // Mark the current tail before streaming so we only publish records
    // appended after start() — never a backlog replay.
    const initial = await this.#store.query();
    this.#lastSeenIndex = initial.length;

    // Immediate first poll publishes anything appended between the size read
    // above and now; the interval handles the rest.
    await this.#poll();
    this.#timer = setInterval(() => {
      // Fire-and-forget; #poll is re-entrancy-guarded and never throws.
      void this.#poll();
    }, this.#pollIntervalMs);
  }

  /** Stop the store-watching loop. Idempotent. Does not close the stream. */
  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * Stop watching (if running) and close the underlying stream, tearing down
   * every attached transport. After `close()`, {@link publish} and {@link start}
   * throw.
   */
  async close(): Promise<void> {
    this.stop();
    this.#closed = true;
    await this.#stream.close();
  }

  /**
   * One polling tick: query the store and publish every record appended since
   * the last tick (subject to {@link filter}). Re-entrancy-guarded so an
   * overlapping interval tick is a no-op. Never throws — errors are counted.
   */
  async #poll(): Promise<void> {
    if (this.#polling) return;
    const store = this.#store;
    if (store === undefined) return;
    this.#polling = true;
    try {
      const records = await store.query();
      this.#storePolled++;
      for (let i = this.#lastSeenIndex; i < records.length; i++) {
        const record = records[i];
        if (record === undefined) continue;
        if (this.#filter !== undefined && !matchesFilter(record, this.#filter)) {
          this.#filtered++;
          continue;
        }
        try {
          const result = await this.#stream.publish(record);
          this.#published++;
          this.#errors += result.errors.length;
        } catch {
          // A failing stream publish is observable but never stops the loop.
          this.#errors++;
        }
      }
      this.#lastSeenIndex = records.length;
    } catch {
      // Store query failures (e.g. a transient I/O error) are counted, not fatal.
      this.#errors++;
    } finally {
      this.#polling = false;
    }
  }
}
