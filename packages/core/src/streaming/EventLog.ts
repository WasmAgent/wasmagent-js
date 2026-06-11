/**
 * EventLog — persistent SSE event log with `Last-Event-ID` resume (A2).
 *
 * Wraps an `AsyncGenerator<AgentEvent>` so every event is:
 *  1. tagged with a monotonic, traceId-scoped `eventId` (string-comparable);
 *  2. appended to a persistent {@link KvBackend} (the same one used by
 *     `KvCheckpointer` / `StructuredMemory` — no parallel infrastructure);
 *  3. yielded to the consumer as a tuple `[eventId, AgentEvent]`.
 *
 * On reconnect, the SSE handler reads the `Last-Event-ID` request header,
 * loads the persisted log, and replays only entries with `id > lastSeenId`.
 *
 * The log is keyed under `evlog:<traceId>:<paddedId>` so a single `list()`
 * with prefix `evlog:<traceId>:` returns the run's events in order.
 *
 * Memory model: each event is stored as a separate key (cheap deletes,
 * paged reads). Use `purge(traceId)` to clean up after a run completes.
 *
 * ## Usage (server side)
 *
 *   const log = new EventLog(kvBackend);
 *   for await (const [eventId, ev] of log.tap(agent.run(task), traceId)) {
 *     await sseWriter.write(`id: ${eventId}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev)}\n\n`);
 *   }
 *
 * ## Usage (resume after disconnect)
 *
 *   const lastSeen = req.headers.get("Last-Event-ID");
 *   for await (const [eventId, ev] of log.replay(traceId, lastSeen)) {
 *     await sseWriter.write(`id: ${eventId}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev)}\n\n`);
 *   }
 *   // Then continue tap-ing live events with `tap()` if the run is still active.
 */

import type { KvBackend } from "../checkpoint/index.js";
import type { AgentEvent } from "../types/events.js";

/** Zero-padded width for the per-trace event counter. 12 digits ⇒ 1e12 events per run. */
const ID_WIDTH = 12;

/** Build the canonical KV key for a single event. */
function eventKey(traceId: string, paddedId: string): string {
  return `evlog:${traceId}:${paddedId}`;
}

/** Build the prefix used to enumerate every event for a trace. */
function tracePrefix(traceId: string): string {
  return `evlog:${traceId}:`;
}

/** Pad a number to the canonical fixed width. */
function padId(n: number): string {
  return String(n).padStart(ID_WIDTH, "0");
}

/** Public shape of one persisted event. */
export interface LoggedEvent {
  /** Monotonic, lexicographically-comparable id within the trace. */
  eventId: string;
  /** The original AgentEvent — unchanged. */
  event: AgentEvent;
}

export interface EventLogOptions {
  /**
   * Optional starting counter. Default 0. Pass the previous high-water
   * mark when resuming a run that was interrupted mid-stream.
   */
  startSeq?: number;
}

export class EventLog {
  readonly #kv: Required<KvBackend>;

  constructor(kv: KvBackend) {
    if (!kv.list) {
      throw new Error(
        "EventLog: KvBackend must implement list(prefix) — required for replay()"
      );
    }
    this.#kv = kv as Required<KvBackend>;
  }

  /**
   * Tap a live event stream: persist + tag + re-emit.
   * Each yielded entry contains the assigned eventId and the original event.
   *
   * Persistence is best-effort and synchronous w.r.t. the yield — if the
   * KV write fails we still yield to the client (correctness > durability),
   * but a failure indicates the resume path will have a gap.
   */
  async *tap(
    source: AsyncGenerator<AgentEvent>,
    traceId: string,
    opts: EventLogOptions = {}
  ): AsyncGenerator<LoggedEvent> {
    let seq = opts.startSeq ?? 0;
    for await (const ev of source) {
      const eventId = padId(seq);
      try {
        await this.#kv.put(eventKey(traceId, eventId), JSON.stringify(ev));
      } catch (err) {
        // Surface to caller via the event payload-adjacent path; do not
        // throw — that would terminate an in-flight agent run because of
        // a transient KV outage.
        // eslint-disable-next-line no-console
        console.warn(`[EventLog] persist failed for ${traceId}/${eventId}:`, err);
      }
      yield { eventId, event: ev };
      seq++;
    }
  }

  /**
   * Replay persisted events for a trace, optionally skipping everything
   * ≤ `afterId` (the value sent in the client's `Last-Event-ID` header).
   *
   * `afterId` may be any string — non-numeric or malformed ids are treated
   * as "deliver everything" since they cannot have come from this log.
   */
  async *replay(traceId: string, afterId?: string | null): AsyncGenerator<LoggedEvent> {
    const keys = await this.#kv.list(tracePrefix(traceId));
    keys.sort(); // lexicographic sort == monotonic sort because of fixed-width padding
    const cutoff = afterId && /^\d+$/.test(afterId) ? afterId.padStart(ID_WIDTH, "0") : null;
    for (const key of keys) {
      const eventId = key.slice(tracePrefix(traceId).length);
      if (cutoff && eventId <= cutoff) continue;
      const raw = await this.#kv.get(key);
      if (!raw) continue; // key disappeared between list and get — skip
      let event: AgentEvent;
      try {
        event = JSON.parse(raw) as AgentEvent;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[EventLog] corrupted entry at ${key}, skipping:`, err);
        continue;
      }
      yield { eventId, event };
    }
  }

  /** Highest persisted eventId for a trace, or null if none. */
  async highWaterMark(traceId: string): Promise<string | null> {
    const keys = await this.#kv.list(tracePrefix(traceId));
    if (keys.length === 0) return null;
    keys.sort();
    const last = keys[keys.length - 1];
    return last ? last.slice(tracePrefix(traceId).length) : null;
  }

  /**
   * Compute the next sequence counter for a trace. Use when restarting
   * a run after a process crash so newly-tapped events continue numbering
   * past the last persisted id.
   */
  async nextSeq(traceId: string): Promise<number> {
    const hw = await this.highWaterMark(traceId);
    return hw ? Number(hw) + 1 : 0;
  }

  /** Delete every persisted event for a trace. Call on successful completion. */
  async purge(traceId: string): Promise<void> {
    const keys = await this.#kv.list(tracePrefix(traceId));
    await Promise.all(keys.map((k) => this.#kv.delete(k)));
  }
}

/**
 * Format a single `LoggedEvent` as an SSE frame, including the `id:` line
 * that browsers send back on reconnect via `Last-Event-ID`.
 *
 * Returns the bytes ready for `WritableStream.getWriter().write(...)`.
 */
export function formatSseFrame(logged: LoggedEvent): string {
  // Must escape any embedded newlines in the JSON; JSON.stringify handles that.
  return `id: ${logged.eventId}\nevent: ${logged.event.event}\ndata: ${JSON.stringify(logged.event)}\n\n`;
}
