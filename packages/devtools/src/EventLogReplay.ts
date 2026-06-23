/**
 * A2 — DevTools event-log replay engine.
 *
 * Pure logic. Loads a list of `LoggedEvent`s (from WasmAgent's EventLog
 * or any equivalent source), exposes a navigable timeline, and supports
 * "fork from step N" — produce a new event list that ends at step N so a
 * caller can rerun the agent from that point with different inputs
 * (changed prompt, swapped model, swapped tools).
 *
 * The engine intentionally does NOT know about React or any UI. The
 * `react/` subpath wraps it in a component; this file is consumable from
 * Node, edge runtimes, and tests alike.
 */

import type { AgentEvent } from "@wasmagent/core";

/** Shape we accept — kept structurally compatible with EventLog's LoggedEvent. */
export interface LoggedEvent {
  eventId: string;
  event: AgentEvent;
}

/** Lightweight per-step view derived from the event stream. */
export interface ReplayStep {
  /** 1-based step number, or 0 for events before any `step_start`. */
  step: number;
  /** The event id of the `step_start` (or the first event for step 0). */
  startEventId: string;
  /** Indices into the underlying events array — tracked for fast slicing. */
  fromIndex: number;
  toIndex: number;
  /** Convenience — the events that belong to this step (live reference). */
  events: LoggedEvent[];
}

/** Snapshot returned by select() / forkAt(). */
export interface ReplayCursor {
  /** Total number of events in the underlying log. */
  totalEvents: number;
  /** Total number of steps (a "step" is delimited by `step_start` events). */
  totalSteps: number;
  /** Current step index, 0-based. 0 = pre-first-step events. */
  currentStep: number;
  /** All events up to and including `currentStep`. */
  prefixEvents: LoggedEvent[];
  /** Final answer text if a `final_answer` event exists in `prefixEvents`. */
  finalAnswer: string | null;
}

/** Options accepted by `forkAt`. */
export interface ForkOptions {
  /** Optional — replace the original task with this string when describing the fork. */
  task?: string;
  /** Optional — note the model id swap so docs/tools can render it. */
  modelId?: string;
  /** Optional — free-form note attached to the fork's metadata. */
  note?: string;
}

/** Result of forking — the prefix events + a metadata bundle to feed to a fresh run. */
export interface Fork {
  prefixEvents: LoggedEvent[];
  forkedAtStep: number;
  forkedAtEventId: string;
  meta: ForkOptions & { forkedFromTraceId?: string };
}

/**
 * Replay engine for one trace. Construction is O(n) over the event list;
 * navigation operations are O(1).
 */
export class EventLogReplay {
  readonly #events: LoggedEvent[];
  readonly #steps: ReplayStep[];
  readonly #traceId: string | undefined;

  constructor(events: LoggedEvent[], opts: { traceId?: string } = {}) {
    // Defensive copy so external mutation cannot corrupt the timeline.
    this.#events = [...events];
    this.#traceId = opts.traceId;
    this.#steps = this.#computeSteps();
  }

  /** Number of events in the log. */
  get eventCount(): number {
    return this.#events.length;
  }

  /** Number of distinct steps (delimited by `step_start` events). */
  get stepCount(): number {
    return this.#steps.length;
  }

  /** Read-only view of the underlying events. */
  get events(): readonly LoggedEvent[] {
    return this.#events;
  }

  /** Read-only view of the computed step boundaries. */
  get steps(): readonly ReplayStep[] {
    return this.#steps;
  }

  /**
   * Return a cursor positioned at `step`. Negative values clamp to 0;
   * values past the end clamp to `stepCount`.
   *
   * `prefixEvents` includes everything up to AND INCLUDING the named step
   * — so `select(0)` returns events before the first `step_start`, and
   * `select(stepCount)` returns the full log.
   */
  select(step: number): ReplayCursor {
    const clamped = Math.max(0, Math.min(this.#steps.length, step));
    let prefix: LoggedEvent[];
    if (clamped === 0) {
      prefix =
        this.#steps.length > 0
          ? this.#events.slice(0, this.#steps[0]?.fromIndex)
          : [...this.#events];
    } else {
      const stepEntry = this.#steps[clamped - 1];
      prefix = stepEntry ? this.#events.slice(0, stepEntry.toIndex + 1) : [...this.#events];
    }
    const finalAnswer = findFinalAnswer(prefix);
    return {
      totalEvents: this.#events.length,
      totalSteps: this.#steps.length,
      currentStep: clamped,
      prefixEvents: prefix,
      finalAnswer,
    };
  }

  /**
   * Fork from the given step. Returns the prefix event list AND a metadata
   * bundle the caller can use to spawn a fresh agent run with the prefix
   * replayed in (eg by feeding the events into a new MessageAssembler).
   */
  forkAt(step: number, opts: ForkOptions = {}): Fork {
    const cursor = this.select(step);
    const lastEvent = cursor.prefixEvents[cursor.prefixEvents.length - 1];
    return {
      prefixEvents: cursor.prefixEvents,
      forkedAtStep: cursor.currentStep,
      forkedAtEventId: lastEvent?.eventId ?? "",
      meta: {
        ...opts,
        ...(this.#traceId ? { forkedFromTraceId: this.#traceId } : {}),
      },
    };
  }

  /**
   * Find the highest step index whose first event id is ≤ the given
   * eventId. Lets the UI map a clicked event row back to its step.
   * Returns 0 when the eventId precedes all `step_start`s.
   */
  stepForEventId(eventId: string): number {
    let lastMatch = 0;
    for (let i = 0; i < this.#steps.length; i++) {
      const step = this.#steps[i];
      if (!step) break;
      if (step.startEventId <= eventId) {
        lastMatch = i + 1;
      } else {
        break;
      }
    }
    return lastMatch;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #computeSteps(): ReplayStep[] {
    const out: ReplayStep[] = [];
    let stepIndex = 0;
    for (let i = 0; i < this.#events.length; i++) {
      const ev = this.#events[i];
      if (!ev) continue;
      if (ev.event.event === "step_start") {
        // Close out the previous step (if any) before opening this one.
        const prev = out[out.length - 1];
        if (prev) prev.toIndex = i - 1;
        stepIndex += 1;
        out.push({
          step: stepIndex,
          startEventId: ev.eventId,
          fromIndex: i,
          toIndex: i, // tentative, fixed up below
          events: [],
        });
      }
    }
    // Final close-out for the last step.
    const lastStep = out[out.length - 1];
    if (lastStep) lastStep.toIndex = this.#events.length - 1;
    // Backfill the events arrays.
    for (const s of out) {
      s.events = this.#events.slice(s.fromIndex, s.toIndex + 1);
    }
    return out;
  }
}

function findFinalAnswer(events: LoggedEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]?.event;
    if (!e) continue;
    if (e.event === "final_answer") {
      const data = (e as { data?: { answer?: unknown } }).data;
      if (data && typeof data.answer === "string") return data.answer;
    }
  }
  return null;
}
