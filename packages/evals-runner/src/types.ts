/**
 * Public types for `@agentkit-js/evals-runner`.
 *
 * The runner composes an evaluation as a 3-D matrix:
 *
 *     models  ×  seeds  ×  items  →  per-cell `RunResult`
 *
 * Each cell produces an `AgentTrace` (from agentkit-core) plus the result
 * of every scorer in the suite. We aggregate per-(model,suite) into
 * `SuiteAggregate`, then build a `Pareto` over (acc, costUsd, p95WallMs).
 *
 * This file does NOT depend on any specific provider — `ModelSpec` carries
 * an OpenAI-compatible base URL + model id, the same shape
 * `GenericOpenAICompatModel` consumes. Any vendor that speaks
 * `/chat/completions` works.
 */

import type { AgentTrace, EvalSample, Scorer } from "@agentkit-js/core";

// ── Model + suite shapes ─────────────────────────────────────────────────────

/**
 * A model configuration the runner will exercise. The `id` is what shows
 * up in reports; `modelId` is the wire-level name passed to the endpoint.
 * They differ when a user wants to compare e.g. `gpt-4o-mini@openai` vs
 * `gpt-4o-mini@openrouter` on cost / latency.
 */
export interface ModelSpec {
  /** Stable display id (used as a column key in reports). */
  id: string;
  /** OpenAI-compat /chat/completions base URL. */
  baseUrl: string;
  /** Wire-level model name. Default: same as `id`. */
  modelId?: string;
  /** Bearer key. Default: env OPENAI_API_KEY, or "ollama" for localhost. */
  apiKey?: string;
  /** Default temperature. Default 0 — matches evaluation discipline. */
  temperature?: number;
  /** Optional per-token cost (USD per 1M tokens), used for cost-per-correct. */
  pricePer1MInput?: number;
  pricePer1MOutput?: number;
  /** Display name for human reports. Default: same as `id`. */
  displayName?: string;
}

/**
 * The runner's view of one item in a benchmark. Mirrors agentkit-core's
 * `EvalSample` (so existing core scorers work unchanged) but adds an
 * `expectedAnswerMatcher` hook for fuzzy / regex acceptance and the
 * conversation-style `messages` array used by memory/long-context suites.
 */
export interface BenchmarkItem extends EvalSample {
  /**
   * Optional pre-built message history (for multi-turn / long-context
   * suites). When present, the runner sends these as the prompt instead of
   * `task` alone.
   */
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  /**
   * Override exactMatch with a custom acceptance check. Returns true on
   * pass, false on fail. Useful when the gold answer is ambiguous (e.g.
   * "1 year" / "one year" / "12 months" all acceptable).
   */
  expectedAnswerMatcher?: (modelAnswer: string) => boolean;
  /** Free-form category tag — surfaces in per-item breakdowns. */
  category?: string;
}

/**
 * A benchmark suite — name, items, scorers, optional aggregate hook.
 *
 * Authors of new suites only need to write a function that returns this
 * object; everything else (running, statistics, reporting) is handled
 * by `runEvaluation`.
 */
export interface BenchmarkSuite {
  /** Stable id (used as a column key in reports). */
  name: string;
  /** Human-readable title. */
  title: string;
  /** One-line description shown in `agentkit evals list`. */
  description: string;
  /** The dataset. */
  items: BenchmarkItem[];
  /** Scorers to run against each trace. */
  scorers: Scorer[];
  /**
   * Optional per-item budget. When set, the runner enforces these limits
   * via the model adapter and fails the item if exceeded. Used by the
   * latency-under-budget suite.
   */
  perItemBudget?: {
    maxOutputTokens?: number;
    timeoutMs?: number;
  };
}

// ── Per-cell + per-suite results ────────────────────────────────────────────

/**
 * Result of one (model, seed, item) cell. Carries the full trace so
 * downstream scorers / dashboards can re-aggregate without re-running.
 */
export interface RunResult {
  modelId: string;
  seed: number;
  itemId: string;
  trace: AgentTrace;
  /** Per-scorer scores, keyed by scorer name. */
  scores: Record<string, number>;
  /** Did the canonical "did it pass" predicate fire? Driven by the
   *  exactMatch / item.expectedAnswerMatcher result. */
  passed: boolean;
  /** Wall-clock for the cell, ms. */
  wallMs: number;
  /** Token counts harvested from `model_done` events. */
  tokens: { input: number; output: number; cacheRead: number };
  /** USD spend for this cell, computed from per-token prices on the
   *  ModelSpec. 0 if prices weren't supplied (local Ollama etc.). */
  costUsd: number;
  /** Last error message if the run threw, else null. */
  error: string | null;
}

/** Per-(model × suite) rollup with paired statistics. */
export interface SuiteAggregate {
  modelId: string;
  suiteName: string;
  /** Per-seed accuracies. */
  seedAccs: number[];
  /** Mean accuracy across seeds. */
  meanAcc: number;
  /** Wilson CI on mean accuracy (pooled across seeds). */
  wilsonLo: number;
  wilsonHi: number;
  /** Std-dev of seed accuracies — too high → not reproducible. */
  seedStd: number;
  /** Total tokens used (input + output). */
  totalTokens: number;
  /** Total USD cost. */
  totalCostUsd: number;
  /** Wall-clock distribution. */
  medianWallMs: number;
  p95WallMs: number;
  /** Total items run = items × seeds. */
  totalCells: number;
  /** Cells that passed. */
  passedCells: number;
}

/** Final report shape — everything a markdown / JSON renderer needs. */
export interface EvaluationReport {
  /** ISO timestamp when the run started. Stamped from `startedAtMs`. */
  startedAt: string;
  /** Total wall-clock for the whole evaluation, ms. */
  totalMs: number;
  /** Models exercised. */
  models: ModelSpec[];
  /** Suites exercised. */
  suites: Pick<BenchmarkSuite, "name" | "title" | "description">[];
  /** Seeds. */
  seeds: number[];
  /** Per-(model, suite) aggregate. */
  aggregates: SuiteAggregate[];
  /** Per-cell raw results — exposed so consumers can re-aggregate. */
  cells: RunResult[];
  /** Pareto front over (mean acc, total cost, p95 wall) per (model, suite).
   *  Each entry's modelId is on the front for that suite. */
  pareto: Array<{
    suiteName: string;
    front: Array<{ modelId: string; meanAcc: number; totalCostUsd: number; p95WallMs: number }>;
  }>;
}

// ── Runner options ──────────────────────────────────────────────────────────

export interface RunEvaluationOptions {
  models: ModelSpec[];
  /** One or more suites. Each runs independently against every model. */
  suites: BenchmarkSuite[];
  /** Random seeds to run for reproducibility. Default [0, 1, 2] — the
   *  ≥3-seed minimum every paired-stats discipline requires. */
  seeds?: number[];
  /** Concurrency *per model*. Items within a (model, seed) grid run up
   *  to this many in parallel. Default 4. */
  concurrency?: number;
  /** Optional progress callback fired after each cell completes. */
  onProgress?: (done: number, total: number, cell: RunResult) => void;
}

/**
 * Provider hook: how to call the model. Decoupled from the runner so a
 * caller can inject a deterministic stub model in tests, or swap in a
 * different transport (mTLS, custom auth, agent-with-tools loop, etc).
 *
 * Default implementation lives in `runner.ts` as `defaultProvider()` and
 * dispatches to the OpenAI-compat /chat/completions endpoint.
 */
export interface ModelProvider {
  call(args: {
    model: ModelSpec;
    messages: Array<{ role: string; content: string }>;
    abortSignal?: AbortSignal;
  }): Promise<{ content: string; inputTokens: number; outputTokens: number }>;
}
