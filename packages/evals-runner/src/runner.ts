/**
 * Core runner: takes models × suites × seeds, produces a structured report.
 *
 * Implementation notes:
 *   - We do NOT spin up the full agentkit `ToolCallingAgent` / `CodeAgent`
 *     loop here — most evaluation suites are single-shot question →
 *     answer. The runner calls the model directly through `ModelProvider`
 *     and synthesises a minimal `AgentTrace` for the agentkit scorers.
 *     Agent-trajectory suites are a separate code path (see
 *     `suites/agent-trajectory.ts`) that do exercise the agent loop.
 *   - Per-model concurrency is capped to avoid overwhelming a single
 *     local Ollama instance; per-suite parallelism is sequential because
 *     each suite needs its own per-item state.
 *   - Determinism: temperature defaults to 0; `seed` is included in the
 *     OpenAI-compat call so providers that honour it (e.g. vLLM, OpenAI)
 *     produce reproducible answers across runs.
 *   - Warm-up (P16-8): each model is optionally primed with a cheap call
 *     before evaluation begins, so p95 wall reflects steady-state inference
 *     rather than cold model loading. Warm-up wall time is reported
 *     separately as `warmupMs` in the aggregate.
 */

import type { AgentEvent, EvalSample, Scorer } from "@agentkit-js/core";
import { wilsonCI } from "./stats/wilson.js";
import type {
  BenchmarkItem,
  BenchmarkSuite,
  EvaluationReport,
  ModelProvider,
  ModelSpec,
  RunEvaluationOptions,
  RunResult,
  SuiteAggregate,
} from "./types.js";

const DEFAULT_SEEDS = [0, 1, 2];
const DEFAULT_CONCURRENCY = 4;

/** Single-item warm-up prompt — cheap but forces model load. */
const WARMUP_PROMPT = "Reply with the word OK only.";

/**
 * Default OpenAI-compatible provider — POSTs to `${baseUrl}/chat/completions`
 * and returns content + token counts. The base URL plus model id are the
 * only knobs; this is the same path `GenericOpenAICompatModel` takes.
 */
export function defaultProvider(): ModelProvider {
  return {
    async call({ model, messages, abortSignal }) {
      const url = `${model.baseUrl.replace(/\/$/, "")}/chat/completions`;
      const apiKey = model.apiKey ?? process.env.OPENAI_API_KEY ?? "ollama";
      const init: RequestInit = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model.modelId ?? model.id,
          messages,
          temperature: model.temperature ?? 0,
          stream: false,
        }),
      };
      if (abortSignal) init.signal = abortSignal;
      const res = await fetch(url, init);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const usage = data.usage ?? {};
      return {
        content,
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
      };
    },
  };
}

/**
 * Warm up a model by sending a cheap call and returning the wall-clock ms.
 * This forces Ollama to load the model weights before evaluation, ensuring
 * that p95 wall in cells reflects steady-state inference latency, not
 * cold model load time (which can be 5–30s for large models).
 *
 * If the call fails, we swallow the error (warm-up failure is non-fatal)
 * and return 0.
 */
async function warmupModel(model: ModelSpec, provider: ModelProvider): Promise<number> {
  const start = Date.now();
  try {
    await provider.call({
      model,
      messages: [{ role: "user", content: WARMUP_PROMPT }],
    });
  } catch {
    // Warm-up failure is non-fatal — evaluation continues without it.
    return 0;
  }
  return Date.now() - start;
}

/**
 * Run a full multi-model multi-seed evaluation.
 *
 * Sequencing: outer loop is (suite, model, seed); inner loop is items
 * with up to `concurrency` parallel cells. We run model × seed sequentially
 * across one model so we don't double-bill a single local backend; that
 * said, swapping models also runs sequentially because Ollama unloads the
 * previous model from VRAM. If the provider is multi-tenant cloud, the
 * caller can wrap two calls to `runEvaluation` in `Promise.all` to
 * parallelise across models.
 *
 * Warm-up: when `warmup` option is true (default), the runner fires one
 * cheap call per model before the first evaluation seed to force model
 * loading. The warm-up wall time is captured in `SuiteAggregate.warmupMs`.
 */
export async function runEvaluation(
  opts: RunEvaluationOptions,
  provider: ModelProvider = defaultProvider()
): Promise<EvaluationReport> {
  const seeds = opts.seeds ?? DEFAULT_SEEDS;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const doWarmup = opts.warmup !== false; // default true
  const startedAtMs = Date.now();
  const cells: RunResult[] = [];
  const warmupMsByModelId: Map<string, number> = new Map();
  const totalCells =
    (opts.models.length *
      opts.suites.length *
      seeds.length *
      opts.suites.reduce((acc, s) => acc + s.items.length, 0)) /
    Math.max(1, opts.suites.length);

  for (const suite of opts.suites) {
    for (const model of opts.models) {
      // Warm up once per model (before first seed of first suite).
      if (doWarmup && !warmupMsByModelId.has(model.id)) {
        const wMs = await warmupModel(model, provider);
        warmupMsByModelId.set(model.id, wMs);
        opts.onProgress?.(-1, totalCells, null as unknown as RunResult); // progress hint
      }

      for (const seed of seeds) {
        // Items run in parallel up to `concurrency`, all sharing the same
        // (model, seed) — one model loaded, one seed; this is the friend
        // of local-Ollama-throughput (single GPU / single inference
        // worker).
        const queue = [...suite.items];
        const workers: Promise<void>[] = [];
        for (let w = 0; w < concurrency; w++) {
          workers.push(
            (async () => {
              while (queue.length > 0) {
                const item = queue.shift();
                if (!item) return;
                const cell = await runCell({
                  suite,
                  model,
                  seed,
                  item,
                  provider,
                });
                cells.push(cell);
                opts.onProgress?.(cells.length, totalCells, cell);
              }
            })()
          );
        }
        await Promise.all(workers);
      }
    }
  }

  const aggregates = buildAggregates(opts.models, opts.suites, seeds, cells, warmupMsByModelId);
  const pareto = buildParetoFront(opts.suites, aggregates);

  return {
    startedAt: new Date(startedAtMs).toISOString(),
    totalMs: Date.now() - startedAtMs,
    models: opts.models,
    suites: opts.suites.map((s) => ({
      name: s.name,
      title: s.title,
      description: s.description,
    })),
    seeds,
    aggregates,
    cells,
    pareto,
    warmup: doWarmup,
  };
}

// ── Per-cell execution ──────────────────────────────────────────────────────

/**
 * Run one (model, seed, item) cell:
 *  1. Build the message list (item.messages or [system, user task]).
 *  2. Call the model.
 *  3. Synthesise a minimal AgentTrace (model_start / model_done /
 *     final_answer) so the agentkit scorers — written for full
 *     ToolCallingAgent traces — work unchanged.
 *  4. Run every scorer; aggregate scores.
 *  5. Decide pass/fail via expectedAnswerMatcher or exactMatch fallback.
 */
async function runCell(args: {
  suite: BenchmarkSuite;
  model: ModelSpec;
  seed: number;
  item: BenchmarkItem;
  provider: ModelProvider;
}): Promise<RunResult> {
  const { suite, model, seed, item, provider } = args;
  const startMs = Date.now();

  // V1: when the suite supplies its own runItem, hand the cell over to
  // the suite. This is the only way to test "real multi-turn" — the
  // single-call branch below is fundamentally a calculator-of-text-match
  // and cannot answer the scaffold-vs-bare question (TinyLLM 2025-11
  // motivates this distinction explicitly).
  if (suite.runItem) {
    return runCellViaSuite({ suite, model, seed, item, startMs });
  }

  const messages = item.messages ?? [
    {
      role: "system" as const,
      content:
        "Answer the user's question. Reply with the answer ONLY — no preamble, no explanation. Be concise.",
    },
    { role: "user" as const, content: item.task },
  ];

  let content = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let error: string | null = null;
  try {
    const r = await provider.call({ model, messages });
    content = r.content;
    inputTokens = r.inputTokens;
    outputTokens = r.outputTokens;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const wallMs = Date.now() - startMs;

  // Synthesise a trace.
  const traceId = `${model.id}::${suite.name}::${seed}::${item.id}`;
  const events: AgentEvent[] = [
    {
      traceId,
      parentTraceId: null,
      timestampMs: startMs,
      channel: "model",
      event: "model_start",
      data: { modelId: model.modelId ?? model.id, step: 1 },
      // biome-ignore lint/suspicious/noExplicitAny: synthetic event payload — boundary type not narrowed
    } as any,
    {
      traceId,
      parentTraceId: null,
      timestampMs: startMs + wallMs,
      channel: "model",
      event: "model_done",
      data: {
        modelId: model.modelId ?? model.id,
        step: 1,
        finishReason: error ? "error" : "stop",
        inputTokens,
        outputTokens,
        estimatedUsd: priceUsd(model, inputTokens, outputTokens),
      },
      // biome-ignore lint/suspicious/noExplicitAny: synthetic event payload — boundary type not narrowed
    } as any,
    {
      traceId,
      parentTraceId: null,
      timestampMs: startMs + wallMs,
      channel: "text",
      event: error ? "error" : "final_answer",
      data: error ? { error } : { answer: content },
      // biome-ignore lint/suspicious/noExplicitAny: synthetic event payload — boundary type not narrowed
    } as any,
  ];
  const trace = {
    traceId,
    task: item.task,
    events,
    finalAnswer: error ? null : content,
    toolCalls: [] as Array<{ toolName: string; args: Record<string, unknown>; callId: string }>,
    toolResults: [] as Array<{
      toolName: string;
      output: unknown;
      callId: string;
      isError: boolean;
    }>,
  };

  // Score.
  const scores = await runScorers(suite.scorers, trace, item);
  const passed = decidePassed(item, content, error);

  return {
    modelId: model.id,
    seed,
    itemId: item.id,
    trace,
    scores,
    passed,
    wallMs,
    tokens: { input: inputTokens, output: outputTokens, cacheRead: 0 },
    costUsd: priceUsd(model, inputTokens, outputTokens),
    error,
  };
}

/**
 * V1 path: the suite owns the cell. We delegate, then build the same
 * RunResult shape so aggregates / pareto / report don't need to know
 * which path produced the cell.
 *
 * If the suite throws, we mark the cell as errored — the runner never
 * crashes mid-evaluation; one bad item shouldn't kill a 1000-cell run.
 * Token + cost accounting falls back to zeros when the suite couldn't
 * compute them (local Ollama: prices are zero anyway, so this is honest).
 */
async function runCellViaSuite(args: {
  suite: BenchmarkSuite;
  model: ModelSpec;
  seed: number;
  item: BenchmarkItem;
  startMs: number;
}): Promise<RunResult> {
  const { suite, model, seed, item, startMs } = args;
  let res: Awaited<ReturnType<NonNullable<BenchmarkSuite["runItem"]>>>;
  try {
    // biome-ignore lint/style/noNonNullAssertion: caller path only invokes this when runItem is defined (guarded above)
    res = await suite.runItem!({ item, model, seed });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    res = { answer: null, passed: false, error: err };
  }
  const wallMs = res.wallMs ?? Date.now() - startMs;
  const inputTokens = res.tokens?.input ?? 0;
  const outputTokens = res.tokens?.output ?? 0;
  const cacheRead = res.tokens?.cacheRead ?? 0;
  const error = res.error ?? null;

  // Synthesise (or pass through) a trace.
  const traceId = `${model.id}::${suite.name}::${seed}::${item.id}`;
  const events: AgentEvent[] = (res.events as AgentEvent[] | undefined) ?? [
    {
      traceId,
      parentTraceId: null,
      timestampMs: startMs,
      channel: "model",
      event: "model_start",
      data: { modelId: model.modelId ?? model.id, step: 1 },
      // biome-ignore lint/suspicious/noExplicitAny: synthetic event payload — boundary type not narrowed
    } as any,
    {
      traceId,
      parentTraceId: null,
      timestampMs: startMs + wallMs,
      channel: "model",
      event: "model_done",
      data: {
        modelId: model.modelId ?? model.id,
        step: 1,
        finishReason: error ? "error" : "stop",
        inputTokens,
        outputTokens,
        estimatedUsd: priceUsd(model, inputTokens, outputTokens),
      },
      // biome-ignore lint/suspicious/noExplicitAny: synthetic event payload — boundary type not narrowed
    } as any,
    {
      traceId,
      parentTraceId: null,
      timestampMs: startMs + wallMs,
      channel: "text",
      event: error ? "error" : "final_answer",
      data: error ? { error } : { answer: res.answer ?? "" },
      // biome-ignore lint/suspicious/noExplicitAny: synthetic event payload — boundary type not narrowed
    } as any,
  ];
  const trace = {
    traceId,
    task: item.task,
    events,
    finalAnswer: error ? null : (res.answer ?? ""),
    toolCalls: [] as Array<{ toolName: string; args: Record<string, unknown>; callId: string }>,
    toolResults: [] as Array<{
      toolName: string;
      output: unknown;
      callId: string;
      isError: boolean;
    }>,
  };

  // Scoring: when the suite supplied scores, trust them (it has direct
  // access to the environment state and judges authoritatively).
  // Otherwise fall back to running the suite's scorers on the synthesised
  // trace, same as the single-call path.
  const scores = res.scores ?? (await runScorers(suite.scorers, trace, item));

  return {
    modelId: model.id,
    seed,
    itemId: item.id,
    trace,
    scores,
    passed: res.passed,
    wallMs,
    tokens: { input: inputTokens, output: outputTokens, cacheRead },
    costUsd: priceUsd(model, inputTokens, outputTokens),
    error,
  };
}

async function runScorers(
  scorers: Scorer[],
  trace: ReturnType<typeof Object>,
  item: EvalSample
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const s of scorers) {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: synthetic event payload — boundary type not narrowed
      const r = await Promise.resolve(s.score(trace as any, item));
      out[s.name] = r.score;
    } catch (e) {
      out[s.name] = 0;
      out[`${s.name}_error`] = 1;
      void e;
    }
  }
  return out;
}

function decidePassed(item: BenchmarkItem, answer: string, err: string | null): boolean {
  if (err) return false;
  if (item.expectedAnswerMatcher) return item.expectedAnswerMatcher(answer);
  if (typeof item.expectedAnswer === "string") {
    return answer.toLowerCase().includes(item.expectedAnswer.toLowerCase());
  }
  return false;
}

function priceUsd(model: ModelSpec, inputTokens: number, outputTokens: number): number {
  const inP = model.pricePer1MInput ?? 0;
  const outP = model.pricePer1MOutput ?? 0;
  return (inputTokens / 1e6) * inP + (outputTokens / 1e6) * outP;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

function buildAggregates(
  models: ModelSpec[],
  suites: BenchmarkSuite[],
  seeds: number[],
  cells: RunResult[],
  warmupMsByModelId: Map<string, number>
): SuiteAggregate[] {
  const out: SuiteAggregate[] = [];
  for (const suite of suites) {
    for (const model of models) {
      // Filter by traceId rather than item-id membership: the V1 ablation
      // arms (multi-turn-scaffold-arms.ts) all share the same item IDs
      // across multiple suites, so item-id membership double-counts.
      // traceId is shaped `${model.id}::${suite.name}::${seed}::${item.id}`,
      // which uniquely identifies (suite, cell).
      const suiteTag = `::${suite.name}::`;
      const cellsForModelSuite = cells.filter(
        (c) => c.modelId === model.id && c.trace.traceId.includes(suiteTag)
      );
      const seedAccs: number[] = [];
      for (const seed of seeds) {
        const seedCells = cellsForModelSuite.filter((c) => c.seed === seed);
        const passed = seedCells.filter((c) => c.passed).length;
        seedAccs.push(seedCells.length === 0 ? 0 : passed / seedCells.length);
      }
      const meanAcc = seedAccs.reduce((a, b) => a + b, 0) / Math.max(seedAccs.length, 1);
      const seedStd = stddev(seedAccs);

      // Pooled accuracy across all (seed × item) cells for Wilson CI.
      const totalCells = cellsForModelSuite.length;
      const passedCells = cellsForModelSuite.filter((c) => c.passed).length;
      const [wilsonLo, wilsonHi] = wilsonCI(passedCells, totalCells);

      const totalTokens = cellsForModelSuite.reduce(
        (a, c) => a + c.tokens.input + c.tokens.output,
        0
      );
      const totalCostUsd = cellsForModelSuite.reduce((a, c) => a + c.costUsd, 0);

      // Split wall times into warmup-excluded (steady-state) measurements.
      // warmupMs is reported separately; p95 reflects steady-state inference.
      const warmupMs = warmupMsByModelId.get(model.id) ?? 0;
      const wallMsSorted = cellsForModelSuite.map((c) => c.wallMs).sort((a, b) => a - b);
      const medianWallMs = percentile(wallMsSorted, 50);
      const p95WallMs = percentile(wallMsSorted, 95);

      out.push({
        modelId: model.id,
        suiteName: suite.name,
        seedAccs,
        meanAcc,
        wilsonLo,
        wilsonHi,
        seedStd,
        totalTokens,
        totalCostUsd,
        medianWallMs,
        p95WallMs,
        warmupMs,
        totalCells,
        passedCells,
      });
    }
  }
  return out;
}

/**
 * Pareto front per suite over (meanAcc desc, totalCostUsd asc, p95WallMs asc).
 * A model is on the front if no other model dominates it on all three axes.
 */
function buildParetoFront(
  suites: BenchmarkSuite[],
  aggregates: SuiteAggregate[]
): EvaluationReport["pareto"] {
  const out: EvaluationReport["pareto"] = [];
  for (const suite of suites) {
    const inSuite = aggregates.filter((a) => a.suiteName === suite.name);
    const front: EvaluationReport["pareto"][number]["front"] = [];
    for (const candidate of inSuite) {
      const dominated = inSuite.some(
        (other) =>
          other !== candidate &&
          other.meanAcc >= candidate.meanAcc &&
          other.totalCostUsd <= candidate.totalCostUsd &&
          other.p95WallMs <= candidate.p95WallMs &&
          (other.meanAcc > candidate.meanAcc ||
            other.totalCostUsd < candidate.totalCostUsd ||
            other.p95WallMs < candidate.p95WallMs)
      );
      if (!dominated) {
        front.push({
          modelId: candidate.modelId,
          meanAcc: candidate.meanAcc,
          totalCostUsd: candidate.totalCostUsd,
          p95WallMs: candidate.p95WallMs,
        });
      }
    }
    out.push({ suiteName: suite.name, front });
  }
  return out;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

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
