import type { EvidenceStoreQuery } from "./evidenceStore.js";
import { matchesFilter } from "./evidenceStore.js";
import type { AEPRecord } from "./types.js";

/**
 * evidenceStream.ts — pub/sub interface for real-time AEP record broadcasting
 * across agent processes and network boundaries (Milestone 6, issue #252).
 *
 * An {@link EvidenceStream} provides a lightweight publish/subscribe layer on
 * top of AEP records. Unlike {@link EvidenceRouter} (which classifies tiers
 * and fans out to storage sinks), the stream focuses on **real-time delivery**
 * to in-process subscribers and pluggable **transport adapters** that bridge
 * across process and network boundaries.
 *
 * ## Design goals
 *
 * 1. **In-process fan-out** — zero-dependency callback-based subscription with
 *    optional content filtering (reuses {@link EvidenceStoreQuery} predicates).
 * 2. **Transport adapters** — pluggable outbound/inbound adapters let the stream
 *    broadcast records over any transport (WebSocket, message queue, IPC, etc.)
 *    without coupling the core to a specific protocol.
 * 3. **Error isolation** — a failing subscriber or transport adapter never
 *    aborts delivery to other targets; errors are captured in
 *    {@link StreamPublishResult.errors}.
 * 4. **Lifecycle** — `close()` tears down all adapters and clears subscriptions.
 *
 * @example
 * ```ts
 * import { EvidenceStream, InMemoryEvidenceStore } from "@wasmagent/aep";
 *
 * const stream = new EvidenceStream();
 *
 * // In-process subscriber
 * const sub = stream.subscribe((event) => {
 *   console.log("received:", event.record.run_id);
 * });
 *
 * // Transport adapter (e.g. WebSocket broadcast)
 * stream.addTransport({
 *   name: "ws-broadcast",
 *   send: async (event) => ws.send(JSON.stringify(event)),
 *   close: async () => ws.close(),
 * });
 *
 * await stream.publish(record);
 * // → subscriber callback fires, transport send() fires
 *
 * stream.unsubscribe(sub);
 * stream.close();
 * ```
 */

/** A record wrapped with stream metadata for delivery to subscribers. */
export interface StreamEvent {
  /** The AEP record being broadcast. */
  readonly record: AEPRecord;
  /** Monotonically increasing sequence number within this stream instance. */
  readonly sequence: number;
  /** Timestamp (ms) when the stream published this event. */
  readonly publishedAtMs: number;
  /** The stream's topic (defaults to the stream id). */
  readonly topic: string;
}

/**
 * Callback invoked for each published event whose record matches the
 * subscription filter (or all events if no filter).
 */
export type StreamSubscriber = (event: StreamEvent) => void | Promise<void>;

/**
 * Opaque handle for a stream subscription. Pass to
 * {@link EvidenceStream.unsubscribe} to cancel.
 */
export interface StreamSubscription {
  /** Unique subscription identifier. */
  readonly id: string;
  /** The filter this subscription was created with, if any. */
  readonly filter?: EvidenceStoreQuery;
}

/**
 * Outbound transport adapter — bridges stream events to an external
 * delivery mechanism (WebSocket, message queue, IPC channel, etc.).
 *
 * Each adapter receives **every** published event (filtering is the
 * adapter's responsibility when needed). Adapters that fail are
 * isolated into `result.errors` and never abort other deliveries.
 */
export interface StreamTransportOutbound {
  /** Transport name (appears in errors and telemetry). */
  readonly name: string;
  /**
   * Send an event to the remote side. May be async. Throw to signal
   * a delivery failure (captured, never aborting).
   */
  send(event: StreamEvent): void | Promise<void>;
  /**
   * Tear down the transport. Called by {@link EvidenceStream.close}.
   * Must not throw.
   */
  close?(): void | Promise<void>;
}

/**
 * Inbound transport adapter — feeds external events into the stream
 * so that records arriving from other processes are published locally.
 *
 * Use {@link EvidenceStream.addInbound} to register an inbound adapter
 * and start feeding events through it.
 */
export interface StreamTransportInbound {
  /** Transport name (appears in telemetry). */
  readonly name: string;
  /**
   * Subscribe to the external source and forward events through the
   * provided callback. The transport calls `onEvent(event)` for each
   * inbound record. Returns a cleanup function called by
   * {@link EvidenceStream.close}.
   */
  listen(
    onEvent: (event: StreamEvent) => void
  ): void | (() => void) | Promise<(() => void) | undefined>;
}

/** A captured error from a subscriber or transport during publish. */
export interface StreamDeliveryError {
  /** Identifier of the failing target ("subscriber:<id>" or "transport:<name>"). */
  readonly target: string;
  /** "subscriber" or "transport". */
  readonly kind: "subscriber" | "transport";
  /** The thrown value. */
  readonly error: unknown;
}

/** Result of {@link EvidenceStream.publish}. */
export interface StreamPublishResult {
  /** Sequence number assigned to this event. */
  readonly sequence: number;
  /** Number of in-process subscribers that received the event. */
  readonly deliveredToSubscribers: number;
  /** Number of outbound transports that successfully sent. */
  readonly deliveredToTransports: number;
  /** Errors captured during delivery (never aborts the fan-out). */
  readonly errors: StreamDeliveryError[];
}

/** Options for constructing an {@link EvidenceStream}. */
export interface EvidenceStreamOptions {
  /**
   * Stream topic name. Subscribers and transports see this in each
   * {@link StreamEvent.topic}. Defaults to a generated id.
   */
  readonly topic?: string;
  /**
   * Maximum number of events to retain in the replay buffer. When set,
   * {@link replay} returns at most this many recent events. Defaults to 0
   * (no replay buffer).
   */
  readonly replayBufferSize?: number;
}

/**
 * EvidenceStream — pub/sub interface for real-time AEP record broadcasting.
 *
 * Supports in-process subscribers (with optional content filters), outbound
 * transport adapters (for cross-process/network delivery), and inbound
 * transport adapters (for receiving records from remote processes).
 */
export class EvidenceStream {
  readonly #topic: string;
  readonly #replayBuffer: StreamEvent[];
  readonly #maxReplaySize: number;
  readonly #subscribers = new Map<
    string,
    { filter?: EvidenceStoreQuery; callback: StreamSubscriber }
  >();
  readonly #outboundTransports = new Map<string, StreamTransportOutbound>();
  readonly #inboundCleanups = new Map<string, () => void | Promise<void>>();
  #sequence = 0;
  #nextSubscriberId = 0;
  #closed = false;

  constructor(options: EvidenceStreamOptions = {}) {
    this.#topic = options.topic ?? `stream-${crypto.randomUUID().slice(0, 8)}`;
    this.#maxReplaySize = options.replayBufferSize ?? 0;
    this.#replayBuffer = this.#maxReplaySize > 0 ? [] : [];
  }

  /** The stream's topic identifier. */
  get topic(): string {
    return this.#topic;
  }

  /** Current sequence number (0 until the first publish). */
  get sequence(): number {
    return this.#sequence;
  }

  /** Number of active in-process subscribers. */
  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /** Number of registered outbound transports. */
  get transportCount(): number {
    return this.#outboundTransports.size;
  }

  /**
   * Subscribe to events published on this stream. If `filter` is provided,
   * the subscriber only receives events whose record matches the filter.
   *
   * @returns An opaque handle for later {@link unsubscribe}.
   */
  subscribe(callback: StreamSubscriber, filter?: EvidenceStoreQuery): StreamSubscription {
    if (this.#closed) throw new Error("Cannot subscribe to a closed EvidenceStream");
    const id = `sub-${this.#nextSubscriberId++}`;
    this.#subscribers.set(id, filter === undefined ? { callback } : { callback, filter });
    return filter === undefined ? { id } : { id, filter };
  }

  /** Cancel a subscription. Returns `true` if it was active. */
  unsubscribe(subscription: StreamSubscription | string): boolean {
    const id = typeof subscription === "string" ? subscription : subscription.id;
    return this.#subscribers.delete(id);
  }

  /**
   * Register an outbound transport adapter. The transport's `send()` is
   * invoked for every published event.
   */
  addTransport(transport: StreamTransportOutbound): void {
    if (this.#closed) throw new Error("Cannot add transport to a closed EvidenceStream");
    this.#outboundTransports.set(transport.name, transport);
  }

  /** Remove an outbound transport by name. Returns `true` if found. */
  removeTransport(name: string): boolean {
    return this.#outboundTransports.delete(name);
  }

  /**
   * Register an inbound transport adapter. The adapter's `listen()` is called
   * immediately; it should call the provided callback for each inbound event.
   * The cleanup function returned by `listen()` is stored and called on
   * {@link close}.
   */
  async addInbound(transport: StreamTransportInbound): Promise<void> {
    if (this.#closed) throw new Error("Cannot add inbound transport to a closed EvidenceStream");
    const cleanup = await transport.listen((event) => {
      // Replay-buffer inbound events too so they're available via replay().
      this.#addToReplayBuffer(event);
      // Fan out to local subscribers (but NOT back to outbound transports
      // to prevent infinite broadcast loops).
      this.#deliverToSubscribers(event);
    });
    if (cleanup !== undefined) {
      // Normalize async cleanups (Promise<() => void>) to sync (() => void).
      this.#inboundCleanups.set(
        transport.name,
        typeof cleanup === "function" ? cleanup : () => cleanup
      );
    }
  }

  /**
   * Publish a record to all subscribers and outbound transports.
   * The record is wrapped in a {@link StreamEvent} with a monotonically
   * increasing sequence number.
   *
   * Per-target errors are captured and never abort delivery.
   */
  async publish(record: AEPRecord): Promise<StreamPublishResult> {
    if (this.#closed) throw new Error("Cannot publish to a closed EvidenceStream");

    const seq = ++this.#sequence;
    const event: StreamEvent = {
      record,
      sequence: seq,
      publishedAtMs: Date.now(),
      topic: this.#topic,
    };

    this.#addToReplayBuffer(event);

    const errors: StreamDeliveryError[] = [];

    // Deliver to in-process subscribers
    const deliveredToSubscribers = this.#deliverToSubscribers(event, errors);

    // Send to outbound transports
    let deliveredToTransports = 0;
    for (const [name, transport] of this.#outboundTransports) {
      try {
        await transport.send(event);
        deliveredToTransports++;
      } catch (err) {
        errors.push({ target: `transport:${name}`, kind: "transport", error: err });
      }
    }

    return { sequence: seq, deliveredToSubscribers, deliveredToTransports, errors };
  }

  /**
   * Replay events from the replay buffer. Requires a non-zero
   * `replayBufferSize` at construction time.
   *
   * @param count - Maximum number of events to replay (default: all buffered).
   */
  replay(count?: number): ReadonlyArray<StreamEvent> {
    const take = count ?? this.#replayBuffer.length;
    return this.#replayBuffer.slice(-take);
  }

  /**
   * Close the stream: tear down all inbound and outbound transports,
   * clear subscriptions and the replay buffer.
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#subscribers.clear();
    this.#replayBuffer.length = 0;

    // Close outbound transports
    for (const [, transport] of this.#outboundTransports) {
      try {
        await transport.close?.();
      } catch {
        // Best-effort cleanup
      }
    }
    this.#outboundTransports.clear();

    // Run inbound cleanups
    for (const [, cleanup] of this.#inboundCleanups) {
      try {
        await cleanup();
      } catch {
        // Best-effort cleanup
      }
    }
    this.#inboundCleanups.clear();
  }

  /** Whether the stream has been closed. */
  get closed(): boolean {
    return this.#closed;
  }

  #addToReplayBuffer(event: StreamEvent): void {
    if (this.#maxReplaySize === 0) return;
    this.#replayBuffer.push(event);
    if (this.#replayBuffer.length > this.#maxReplaySize) {
      this.#replayBuffer.shift();
    }
  }

  /**
   * Deliver an event to all matching in-process subscribers.
   * Returns the count of successful deliveries; optionally appends
   * errors to the provided array.
   */
  #deliverToSubscribers(event: StreamEvent, errors?: StreamDeliveryError[]): number {
    let count = 0;
    for (const [id, sub] of this.#subscribers) {
      if (sub.filter !== undefined && !matchesFilter(event.record, sub.filter)) continue;
      try {
        const result = sub.callback(event);
        // Handle async subscribers (fire-and-forget within the publish cycle).
        if (result instanceof Promise) {
          result.catch((err) =>
            errors?.push({ target: `subscriber:${id}`, kind: "subscriber", error: err })
          );
        }
        count++;
      } catch (err) {
        errors?.push({ target: `subscriber:${id}`, kind: "subscriber", error: err });
      }
    }
    return count;
  }
}
