/**
 * EfficiencyScorer — composite efficiency metric over an AgentTrace.
 *
 * Penalizes runs that exceed configured budgets for tokens, duration,
 * cost, or step count. Score is the geometric mean of the individual
 * sub-scores, each in [0, 1].
 *
 * If a budget isn't configured, that sub-score is omitted from the
 * geometric mean. With no budgets at all, the scorer returns 1.0.
 */

import type { AgentEvent } from "../types/events.js";
import type { AgentTrace, Scorer, ScorerResult } from "./index.js";

export interface EfficiencyConstraints {
  /** Cap on total input + output tokens. */
  maxTokens?: number;
  /** Cap on wall-clock duration in milliseconds. */
  maxDurationMs?: number;
  /** Cap on USD cost. */
  maxCostUsd?: number;
  /** Cap on step count (each step_start event). */
  maxSteps?: number;
}

interface TraceMetrics {
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  costUsd: number;
  steps: number;
}

function extractMetrics(trace: AgentTrace): TraceMetrics {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let steps = 0;
  let firstTs = 0;
  let lastTs = 0;

  for (const ev of trace.events as AgentEvent[]) {
    if (ev.timestampMs > 0) {
      if (firstTs === 0 || ev.timestampMs < firstTs) firstTs = ev.timestampMs;
      if (ev.timestampMs > lastTs) lastTs = ev.timestampMs;
    }
    if (ev.event === "step_start") steps++;
    if (ev.event === "model_done") {
      const d = ev.data as {
        inputTokens?: number;
        outputTokens?: number;
        costUsd?: number;
      };
      inputTokens += d.inputTokens ?? 0;
      outputTokens += d.outputTokens ?? 0;
      costUsd += d.costUsd ?? 0;
    }
  }

  return {
    inputTokens,
    outputTokens,
    durationMs: lastTs > firstTs ? lastTs - firstTs : 0,
    costUsd,
    steps,
  };
}

/** Score a single budget dimension: 1 if under, 0 if 2x over, linear between. */
function dimensionScore(actual: number, budget: number): number {
  if (actual <= budget) return 1;
  if (actual >= budget * 2) return 0;
  return 1 - (actual - budget) / budget;
}

export function efficiencyScorer(constraints: EfficiencyConstraints = {}): Scorer {
  return {
    name: "efficiency",
    score(trace: AgentTrace): ScorerResult {
      const m = extractMetrics(trace);
      const subScores: number[] = [];
      const detailParts: string[] = [];

      if (constraints.maxTokens !== undefined) {
        const total = m.inputTokens + m.outputTokens;
        const s = dimensionScore(total, constraints.maxTokens);
        subScores.push(s);
        detailParts.push(`tokens=${total}/${constraints.maxTokens}`);
      }
      if (constraints.maxDurationMs !== undefined) {
        const s = dimensionScore(m.durationMs, constraints.maxDurationMs);
        subScores.push(s);
        detailParts.push(`duration=${m.durationMs}ms/${constraints.maxDurationMs}ms`);
      }
      if (constraints.maxCostUsd !== undefined) {
        const s = dimensionScore(m.costUsd, constraints.maxCostUsd);
        subScores.push(s);
        detailParts.push(`cost=$${m.costUsd.toFixed(4)}/$${constraints.maxCostUsd}`);
      }
      if (constraints.maxSteps !== undefined) {
        const s = dimensionScore(m.steps, constraints.maxSteps);
        subScores.push(s);
        detailParts.push(`steps=${m.steps}/${constraints.maxSteps}`);
      }

      if (subScores.length === 0) {
        return { scorer: "efficiency", score: 1, detail: "no budgets configured" };
      }
      // Geometric mean — zero on any sub-dimension drives the total to zero.
      const product = subScores.reduce((a, b) => a * b, 1);
      const geoMean = subScores.length === 0 ? 1 : product ** (1 / subScores.length);
      return { scorer: "efficiency", score: geoMean, detail: detailParts.join("; ") };
    },
  };
}
