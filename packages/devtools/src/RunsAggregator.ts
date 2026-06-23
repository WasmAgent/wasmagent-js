/**
 * RunsAggregator — A4 (S3 strategic line, 2026-06).
 *
 * Pure-logic data layer for the local Studio's "runs overview" page.
 * Mastra Studio's metrics tab earns its reputation by answering one
 * question well: *what did this agent cost me, and where is the latency?*
 * WasmAgent already emits everything needed (`model_done` events carry
 * `inputTokens / outputTokens / cacheReadTokens / estimatedUsd`,
 * `step_start` / `step_end` carry per-step wall-clock, `error` events
 * carry failure reasons) — this aggregator turns that fire-hose into the
 * five summary scalars a user actually scans:
 *
 *   - total cost (USD), input + output + cache-read tokens
 *   - run wall-clock (and median per-step latency)
 *   - error count + final outcome
 *   - p95 latency across the corpus
 *   - eval scores per scorer (when present)
 *
 * The aggregator is read-only: it never mutates the event log. It's safe to
 * point at the same KvBackend the production agent writes to. It does NOT
 * own a UI — `packages/devtools/src/react` consumes its output and renders.
 *
 * Why pure logic: Studio is "zero-deploy local"; we want every aggregation
 * to be runnable in Node, in a Worker, in Bun, in a vitest test — the
 * boundary between data and rendering keeps that promise.
 */

import type { LoggedEvent } from "./EventLogReplay.js";

// ── Per-run summary (scanned in the runs list) ───────────────────────────────

export interface RunSummary {
  /** Stable identifier — the trace id the events share. */
  traceId: string;
  /** First event's wall-clock (ms epoch) — sort key for the runs list. */
  startTs: number;
  /** Last event's wall-clock (ms epoch). */
  endTs: number;
  /** End − start. Note: includes await_human_input pauses; see `activeMs`. */
  wallMs: number;
  /** Sum of step wall-clocks, excluding HITL pauses. */
  activeMs: number;
  /** "complete" if a `final_answer` event landed; "failed" on `error`; else "running". */
  outcome: "complete" | "failed" | "running";
  /** Final answer text when outcome === "complete", else null. */
  finalAnswer: string | null;
  /** Number of `error` events in the stream (a run can survive an error if it later finalised). */
  errorCount: number;
  /** Token totals across all `model_done` events. */
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    thinking: number;
  };
  /** Sum of `estimatedUsd` across all `model_done` events (when present). */
  costUsd: number;
  /** Number of model calls. */
  modelCalls: number;
  /** Number of step_start events seen. */
  steps: number;
  /** Eval scores (scorer name → numeric score) emitted via `eval_score` events. */
  evalScores: Record<string, number>;
}

// ── Corpus-level rollup (the metrics card on Studio's overview page) ────────

export interface RunsRollup {
  totalRuns: number;
  completed: number;
  failed: number;
  running: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  /** Median per-run wall time. */
  medianWallMs: number;
  /** 95th percentile per-run wall time (the latency tail metric). */
  p95WallMs: number;
  /** Average error rate across runs (fraction of runs with errorCount > 0). */
  errorRate: number;
  /**
   * Per-scorer trend: scorer name → array of scores in run order. Allows the
   * UI to show "eval X over the last 100 runs" without re-aggregating.
   */
  evalScoreSeries: Record<string, number[]>;
}

// ── Aggregator ───────────────────────────────────────────────────────────────

/**
 * Build a per-run summary from a single trace's event list. The events must
 * all share `traceId` (caller's responsibility — this layer does not group).
 */
export function summariseRun(events: LoggedEvent[]): RunSummary {
  if (events.length === 0) {
    throw new Error("RunsAggregator: cannot summarise empty event list");
  }
  // First event with a non-zero timestamp wins; some test fixtures stamp 0
  // for a few synthetic events. Non-null after the length check above.
  const first = (events.find((e) => e.event.timestampMs > 0) ?? events[0]) as LoggedEvent;
  const last = events[events.length - 1] as LoggedEvent;
  const startTs = first.event.timestampMs;
  const endTs = last.event.timestampMs || startTs;

  const summary: RunSummary = {
    traceId: first.event.traceId,
    startTs,
    endTs,
    wallMs: Math.max(0, endTs - startTs),
    activeMs: 0,
    outcome: "running",
    finalAnswer: null,
    errorCount: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, thinking: 0 },
    costUsd: 0,
    modelCalls: 0,
    steps: 0,
    evalScores: {},
  };

  let stepStartTs = 0; // ms; 0 = no open step
  let pauseStart = 0; // wall-time we entered a HITL pause
  let pausedMs = 0;

  for (const { event } of events) {
    // We compare on the discriminator as a string so events that exist on
    // adjacent unions (custom `eval_score`, library-internal `step_end`,
    // `human_response`) — but aren't part of the public AgentEvent type
    // union — can still be observed without forcing a `types/events.ts` edit
    // every time the Studio learns a new metric.
    const kind = event.event as string;
    switch (kind) {
      case "step_start":
        stepStartTs = event.timestampMs;
        summary.steps += 1;
        break;
      case "step_end":
        if (stepStartTs > 0) {
          summary.activeMs += Math.max(0, event.timestampMs - stepStartTs);
          stepStartTs = 0;
        }
        break;
      case "model_done": {
        // model_done.data shape (see types/events.ts) carries all the cost
        // axes we need. Cast through unknown to avoid pulling the entire
        // AgentEvent union into this aggregator's type surface.
        const d = event.data as {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          thinkingTokens?: number;
          estimatedUsd?: number;
        };
        summary.tokens.input += d.inputTokens ?? 0;
        summary.tokens.output += d.outputTokens ?? 0;
        summary.tokens.cacheRead += d.cacheReadTokens ?? 0;
        summary.tokens.thinking += d.thinkingTokens ?? 0;
        summary.costUsd += d.estimatedUsd ?? 0;
        summary.modelCalls += 1;
        break;
      }
      case "final_answer":
        summary.outcome = "complete";
        summary.finalAnswer =
          typeof (event.data as { answer?: unknown }).answer === "string"
            ? (event.data as { answer: string }).answer
            : null;
        break;
      case "error":
        summary.errorCount += 1;
        // We do NOT flip outcome to "failed" yet — the run might have a
        // recoverable error followed by a final_answer. Outcome is decided
        // by the post-loop pass below.
        break;
      case "await_human_input":
        pauseStart = event.timestampMs;
        break;
      case "human_response":
        if (pauseStart > 0) {
          pausedMs += Math.max(0, event.timestampMs - pauseStart);
          pauseStart = 0;
        }
        break;
      case "eval_score": {
        const d = event.data as { scorer?: string; score?: number };
        if (typeof d.scorer === "string" && typeof d.score === "number") {
          summary.evalScores[d.scorer] = d.score;
        }
        break;
      }
      default:
        break;
    }
  }

  // Post-loop outcome decision: if no final_answer and any error, mark failed.
  if (summary.outcome === "running" && summary.errorCount > 0) {
    summary.outcome = "failed";
  }

  // wallMs subtracts paused HITL time so the metric reflects "agent active"
  // wall clock — matches what users mean when they ask "how long did this take".
  summary.wallMs = Math.max(0, summary.wallMs - pausedMs);

  return summary;
}

/**
 * Roll up a list of per-run summaries into the corpus card displayed on the
 * Studio overview page. Sorted by startTs ascending so the eval series have
 * a stable left-to-right axis.
 */
export function rollupRuns(summaries: RunSummary[]): RunsRollup {
  const sorted = [...summaries].sort((a, b) => a.startTs - b.startTs);

  const rollup: RunsRollup = {
    totalRuns: sorted.length,
    completed: 0,
    failed: 0,
    running: 0,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    medianWallMs: 0,
    p95WallMs: 0,
    errorRate: 0,
    evalScoreSeries: {},
  };
  if (sorted.length === 0) return rollup;

  let runsWithError = 0;
  for (const s of sorted) {
    if (s.outcome === "complete") rollup.completed += 1;
    else if (s.outcome === "failed") rollup.failed += 1;
    else rollup.running += 1;
    rollup.totalCostUsd += s.costUsd;
    rollup.totalInputTokens += s.tokens.input;
    rollup.totalOutputTokens += s.tokens.output;
    rollup.totalCacheReadTokens += s.tokens.cacheRead;
    if (s.errorCount > 0) runsWithError += 1;
    for (const [scorer, score] of Object.entries(s.evalScores)) {
      const series = rollup.evalScoreSeries[scorer] ?? [];
      series.push(score);
      rollup.evalScoreSeries[scorer] = series;
    }
  }

  rollup.errorRate = runsWithError / sorted.length;

  const wallMsSorted = sorted.map((s) => s.wallMs).sort((a, b) => a - b);
  rollup.medianWallMs = percentile(wallMsSorted, 50);
  rollup.p95WallMs = percentile(wallMsSorted, 95);

  return rollup;
}

/**
 * Percentile over a *sorted ascending* array. We use linear interpolation
 * between neighbours — the standard quantile definition — so the metric
 * stays stable across small N. Returns 0 for an empty input rather than NaN
 * so callers can avoid extra guards in the UI layer.
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0] as number;
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedAsc[lower] as number;
  const frac = rank - lower;
  return (sortedAsc[lower] as number) * (1 - frac) + (sortedAsc[upper] as number) * frac;
}

// ── Helpers for grouping a flat KV log into per-trace lists ────────────────

/**
 * Group a flat list of LoggedEvents (as you'd get from `EventLog.list()`)
 * by traceId. Order within each group is preserved.
 */
export function groupByTraceId(events: LoggedEvent[]): Map<string, LoggedEvent[]> {
  const map = new Map<string, LoggedEvent[]>();
  for (const e of events) {
    const id = e.event.traceId;
    let bucket = map.get(id);
    if (!bucket) {
      bucket = [];
      map.set(id, bucket);
    }
    bucket.push(e);
  }
  return map;
}
