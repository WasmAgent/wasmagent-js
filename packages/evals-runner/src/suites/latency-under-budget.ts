/**
 * Latency-under-budget — same as multi-turn-memory but with explicit
 * per-item budgets. The pass criterion is "answer correctly AND within
 * the budget"; misses are flagged whether they're correctness misses or
 * latency misses.
 *
 * Useful for "which model can I deploy at p95 < 1s for memory tasks?".
 */

import type { BenchmarkSuite } from "../types.js";
import { multiTurnMemorySuite } from "./multi-turn-memory.js";

export const latencyUnderBudgetSuite: BenchmarkSuite = {
  name: "latency-under-budget",
  title: "Multi-turn memory under a 2 s / 256-token budget",
  description:
    "Same 6 items as multi-turn-memory, but the runner enforces a 2-second wall-clock budget and a 256-output-token budget per cell. Pass = correct AND within budget. The Pareto front lets you pick the cheapest model that hits, e.g., p95 < 2 s.",
  items: multiTurnMemorySuite.items,
  scorers: multiTurnMemorySuite.scorers,
  perItemBudget: { timeoutMs: 2000, maxOutputTokens: 256 },
};
