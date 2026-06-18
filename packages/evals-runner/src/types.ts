/**
 * Public types for `@wasmagent/evals-runner`.
 *
 * The runner composes an evaluation as a 3-D matrix:
 *
 *     models  ×  seeds  ×  items  →  per-cell `RunResult`
 *
 * Each cell produces an `AgentTrace` plus the result of every scorer in
 * the suite. We aggregate per-(model,suite) into `SuiteAggregate`, then
 * build a `Pareto` over (acc, costUsd, p95WallMs).
 *
 * This file has **zero runtime dependencies** — it imports nothing from
 * `@wasmagent/core` or any other package. The three shared interfaces
 * (`AgentTrace`, `EvalSample`, `Scorer`) are inlined here using the same
 * field shapes as core; TypeScript structural typing ensures existing core
 * scorers remain assignable to `Scorer` without any cast.
 *
 * This makes `@wasmagent/evals-runner` usable as a framework-neutral
 * referee: callers from Vercel AI SDK, Mastra, OpenAI Agents JS, or any
 * other framework can implement `ModelProvider` and supply `BenchmarkSuite`
 * without depending on `@wasmagent/core`.
 */

// ── Inlined shared interfaces (structurally identical to @wasmagent/core) ────
//
// Why inline rather than import? evals-runner is the "referee" package —
// it should be adoptable by teams that do NOT use agentkit agents at all.
// A hard import of @wasmagent/core would force that dependency on every
// framework-neutral adopter. Because TypeScript uses structural typing,
// a `Scorer` written against core's definition is assignable here with no
// cast needed.

/**
 * A recorded agent run. Framework-agnostic: populate from whatever event
 * log your agent runtime produces. `events` is typed as `unknown[]` so
 * non-agentkit runtimes don't need to map to agentkit event shapes.
 */
export interface AgentTrace {
  traceId: string;
  task: string;
  events: unknown[];
  finalAnswer: string | null;
  toolCalls: Array<{ toolName: string; args: Record<string, unknown>; callId: string }>;
  toolResults: Array<{ toolName: string; output: unknown; callId: string; isError: boolean }>;
}

/** One benchmark item — the minimum the runner needs to drive a cell. */
export interface EvalSample {
  id: string;
  task: string;
  /** Expected final answer (for exactMatch scorer). */
  expectedAnswer?: string;
  /** Expected ordered sequence of tool names (for toolCallAccuracy scorer). */
  expectedTools?: string[];
}

/** A scorer that maps a trace + sample to a [0,1] score. */
export interface Scorer {
  readonly name: string;
  score(trace: AgentTrace, sample: EvalSample): { scorer: string; score: number; detail?: string };
}

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
 *
 * **Two execution paths**: the runner's default single-call path (suitable
 * for QA-style tasks where the model produces an answer in one shot) OR a
 * suite-supplied `runItem` hook that takes ownership of executing the
 * cell. The hook is what V1 (multi-turn-tool-exec) needs: a real
 * `ToolCallingAgent` loop with stateful mock tools, judged on the terminal
 * state of the environment rather than a string match. Suites that set
 * `runItem` are the only ones that can answer the question "can scaffolding
 * pull a 1–2B model's multi-turn accuracy off the cliff" — single-call
 * suites measure the wrong thing for that question by construction.
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
  /**
   * V1 hook: when present, the runner DOES NOT call the provider directly
   * for items in this suite. Instead it delegates the full cell execution
   * to the suite — the suite is then responsible for running whatever it
   * needs (a `ToolCallingAgent` loop, a `CodeAgent` + sandbox, a custom
   * harness) and returning the trace plus pass/fail decision.
   *
   * The hook receives the runner-built ModelSpec; the canonical way to
   * turn that into a `Model` is `new GenericOpenAICompatModel(spec.modelId
   * ?? spec.id, spec.baseUrl, { apiKey, ... })`. `seed` is forwarded so
   * the suite can plumb it into the model call (deterministic providers
   * honour it, others ignore it). `signal` is for cooperative abort.
   *
   * Returning `tokens` is best-effort — set zeros if the harness can't
   * compute them; the runner will still aggregate wall-clock and pass
   * rate. `wallMs` is computed by the runner around the call so the suite
   * doesn't have to, but if the suite measures it itself it can return
   * it and the runner will use that value verbatim.
   */
  runItem?: (args: {
    item: BenchmarkItem;
    model: ModelSpec;
    seed: number;
    signal?: AbortSignal;
  }) => Promise<RunItemResult>;
}

/**
 * The shape a `runItem` hook returns when a suite owns its execution path.
 * Mirrors the relevant subset of `RunResult` — the runner stamps the rest
 * (modelId / seed / itemId / costUsd) before pushing the cell.
 */
export interface RunItemResult {
  /** Final answer text (used as fallback display in reports). */
  answer: string | null;
  /** True if the suite's terminal-state judge accepted the run. */
  passed: boolean;
  /** Wall-clock ms — runner will overwrite if not provided. */
  wallMs?: number;
  /** Tokens consumed during the run (best-effort). */
  tokens?: { input: number; output: number; cacheRead?: number };
  /** Error message if the harness threw, else null. */
  error?: string | null;
  /**
   * Optional events the suite recorded — emitted into the synthesised
   * AgentTrace so existing scorers (and the dashboard) keep working.
   * If absent, the runner stitches a minimal model_start/done/final_answer
   * trace from `answer` + `wallMs`.
   */
  events?: Array<unknown>;
  /** Per-scorer override scores — bypasses the runner's scorer loop when present. */
  scores?: Record<string, number>;
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
  /** Wall-clock distribution (steady-state, excluding warmup). */
  medianWallMs: number;
  p95WallMs: number;
  /**
   * Warm-up call wall-clock for this model (ms). Reported separately so
   * p95WallMs reflects steady-state inference, not cold model loading.
   * 0 when warmup was disabled or failed silently.
   */
  warmupMs: number;
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
  /**
   * Whether warm-up was performed (default true). When false, p95WallMs
   * may include cold model-loading time and should not be compared across
   * models run in different sessions.
   */
  warmup?: boolean;
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
  /**
   * Whether to warm up each model before evaluation (default true).
   * When enabled, a cheap call is fired before the first evaluation seed
   * to force Ollama to load model weights. This ensures p95 wall reflects
   * steady-state inference latency, not cold model loading.
   * Disable in tests or when using a pre-warmed cloud endpoint.
   */
  warmup?: boolean;
  /** Optional progress callback fired after each cell completes.
   *  Also fired with done=-1 when a warm-up call completes (cell is null). */
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
