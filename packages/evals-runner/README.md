# /evals-runner

> Multi-model multi-axis evaluation harness for **any** agent runtime.
> Framework-neutral: the public interface (`BenchmarkSuite`, `Scorer`,
> `ModelProvider`) has zero runtime dependency on `@wasmagent/core`.
> Use it to benchmark Vercel AI SDK agents, Mastra agents, OpenAI Agents JS,
> or plain `/chat/completions` endpoints — no wasmagent runtime required.
> Built-in reference suites that run wasmagent agents are available but
> optional.

wasmagent stays **independent**: this package is the *referee*, not the
*contestant*. It runs the same paired-statistics machinery
(McNemar exact / Wilson CI / paired bootstrap / G1 gate) regardless of
which framework produced the traces.

## Stability: beta

This package is in **beta**. The public interface (`BenchmarkSuite`, `Scorer`, `ModelProvider`,
`runEvaluation`, `renderReportMarkdown`) is stable for production use. Statistical primitives
(`mcnemarExact`, `wilsonCI`, `pairedBootstrap`, `buildG1Report`) are stable. Reference suite
item sets and scoring logic may be refined in minor releases.

## Why this exists

The accuracy-only benchmarks academic projects ship (GSM8K, IFEval,
MMLU, HumanEval) ignore the things production model selection actually
needs:

- **Long-context recall** — does the model retrieve a fact from the
  middle of a 16K document?
- **Multi-turn memory** — can it use a 28-turn dialog history?
- **Trajectory quality** — does an agent loop recover from a failed step?
- **Latency under budget** — accuracy is irrelevant if p95 wall blows
  the budget.
- **Cost per correct answer** — the only axis that decides deployment.

Six reference suites cover those gaps. Plus the statistical primitives
that turn even a small run into a defensible claim:

- `mcnemarExact(b, c)` — exact paired test
- `wilsonCI(s, n)` — proportion CI
- `pairedBootstrap(cand, base)` — distribution-free delta CI
- `buildG1Report(seeds[])` — pooled-across-seeds gate matching the
  ≥3-seed discipline standard in the field

## Install

```bash
# With wasmagent (for the built-in reference suites):
npm install @wasmagent/evals-runner @wasmagent/core

# Framework-neutral (public interface only — no wasmagent runtime):
npm install @wasmagent/evals-runner
```

## Framework-neutral usage

`@wasmagent/evals-runner`'s public interface (`BenchmarkSuite`, `Scorer`,
`ModelProvider`, `AgentTrace`, `EvalSample`) is defined entirely in
`types.ts` with zero imports from `@wasmagent/core`. Any framework can
supply its own scorers and suites:

```ts
import { runEvaluation, renderReportMarkdown } from "@wasmagent/evals-runner";
import type { BenchmarkSuite, Scorer } from "@wasmagent/evals-runner";

// A scorer that checks the answer contains a keyword — no wasmagent needed.
const keywordScorer: Scorer = {
  name: "keyword",
  score(trace, sample) {
    const answer = trace.finalAnswer ?? "";
    const hit = sample.expectedAnswer
      ? answer.toLowerCase().includes(sample.expectedAnswer.toLowerCase())
      : true;
    return { scorer: "keyword", score: hit ? 1 : 0 };
  },
};

// A suite built from your own framework's outputs.
const mySuite: BenchmarkSuite = {
  name: "my-suite",
  title: "My custom suite",
  description: "Tests my agent on 3 items.",
  scorers: [keywordScorer],
  items: [
    { id: "q1", task: "What is 2+2?", expectedAnswer: "4" },
    { id: "q2", task: "Capital of France?", expectedAnswer: "paris" },
    { id: "q3", task: "Boiling point of water in °C?", expectedAnswer: "100" },
  ],
};

const report = await runEvaluation({
  models: [{ id: "my-model", baseUrl: "http://localhost:11434/v1" }],
  suites: [mySuite],
  seeds: [0, 1, 2],
});
console.log(renderReportMarkdown(report));
```

## Quick start (CLI)

```bash
# List the 6 reference suites:
wasmagent evals list

# Run multi-turn memory + cost-per-correct against 2 models, 3 seeds:
wasmagent evals run \
  --suite=multi-turn-memory,cost-per-correct \
  --models="qwen2.5:0.5b@http://localhost:11434/v1,gpt-4o-mini@https://api.openai.com/v1" \
  --seeds=0,1,2 \
  --report-file=./eval-report.md
```

Markdown output: a Pareto-flagged summary table, a per-suite item × model
matrix, a configuration footer. Drop into a PR or commit message verbatim.

## Programmatic use

```ts
import {
  runEvaluation,
  multiTurnMemorySuite,
  costPerCorrectSuite,
  renderReportMarkdown,
} from "/evals-runner";

const report = await runEvaluation({
  models: [
    {
      id: "qwen2.5:0.5b",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "ollama",
      pricePer1MInput: 0,    // local — free
      pricePer1MOutput: 0,
    },
    {
      id: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
      pricePer1MInput: 0.15,
      pricePer1MOutput: 0.60,
    },
  ],
  suites: [multiTurnMemorySuite, costPerCorrectSuite],
  seeds: [0, 1, 2],
});

console.log(renderReportMarkdown(report));
```

## Reference suites

| Suite                    | What it measures                                                       |
| ------------------------ | ---------------------------------------------------------------------- |
| `multi-turn-memory`      | LongMemEval-style conversation-history recall — 60 items across 6 categories (single-session, multi-session, knowledge-update, and variants) |
| `long-context-recall`    | Needle-in-haystack at 10% / 50% / 90% depth in a ~16K-token document   |
| `cost-per-correct`       | Same items as multi-turn-memory; reports USD per passing answer        |
| `tool-sequence`          | 3-step JSON-encoded tool-call plans matched against an expected order  |
| `agent-trajectory`       | Plan + reasoning emission scored by trajectory validity + length       |
| `latency-under-budget`   | Multi-turn memory under a 2 s wall-clock + 256-token budget per item   |

All 6 suites use **synthetic / hand-built fixtures**. None of the items
overlap with publicly published training corpora (GSM8K / MMLU / IFEval /
HumanEval / Alpaca etc.) — that is a deliberate choice so a model fine-
tuned on those public benchmarks does NOT silently leak through. Adding
your own suites is encouraged; see `BenchmarkSuite` in `src/types.ts`.

## Statistical primitives

```ts
import {
  mcnemarExact,
  wilsonCI,
  pairedBootstrap,
  buildG1Report,
} from "/evals-runner/stats";

// Exact McNemar paired test:
const { p } = mcnemarExact(/* b */ 25, /* c */ 5);
// → { p: 3.249e-4, b: 25, c: 5, n: 30 }

// Wilson CI on a binomial proportion:
const [lo, hi] = wilsonCI(/* successes */ 50, /* total */ 100);
// → [0.40383, 0.59617]

// G1 gate over ≥3 seeds:
const g1 = buildG1Report("v1.2 vs baseline", [seed0, seed1, seed2]);
// → { passes: true, pooled: { mcnemarP: 1e-12, ... }, ... }
```

All primitives have parity tests against scipy reference values
(`src/stats/index.test.ts`).

## What is NOT in this package

- **Auto-quantize / auto-merge / auto-train.** This is an evaluation
  harness, not a model-tuning tool. It tells you which model wins; what
  you do with that information lives in your tuning pipeline.
- **GSM8K / MMLU / IFEval / HumanEval suites.** These are common
  training-data leakage vectors. Use `lm-evaluation-harness` if you need
  them; this package focuses on axes those benchmarks don't cover.
- **A leaderboard SaaS.** The output is markdown + JSON; ship it
  yourself.

## Design points

- **Provider-agnostic.** A `ModelSpec` is `{ id, baseUrl, modelId,
  apiKey }` — point at Ollama, OpenRouter, vLLM, AI Gateway, OpenAI,
  Anthropic-compat, or anything else.
- **Deterministic by default.** `temperature=0`. Three seeds enforced.
  Reports `σ across seeds` so you can see when a model's "win" is noise.
- **Pareto-first reporting.** The default summary flags
  non-dominated models on `(meanAcc, totalCostUsd, p95WallMs)` per
  suite — because in real selection you don't want one number, you
  want the deployment trade-off surface.

## Roadmap (v0.2)

- IRT subset selection — pick the most informative N items from a
  larger pool. Lets you publish 50-item numbers as confidently as 500.
- Conformal CI — distribution-free CI for use when bootstrap
  assumptions don't hold.
- Per-model concurrency hooks for clouds with high parallelism budgets.
- Real `ToolCallingAgent` loop in `agent-trajectory` (currently
  string-presence heuristic).

## See also

- [`docs/guides/evals-runner.md`](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/evals-runner.md)
  — full guide with Ollama / OpenRouter / Gateway recipes.
- [`docs/guides/openai-compat-recipes.md`](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/openai-compat-recipes.md)
  — same model-spec format used by the rest of wasmagent.

## Worked example: 2026-06-17 — the referee in action

A real engagement showed up the value of paired statistics. evomerge
(an wasmagent consumer training a 1.7B Qwen3 LoRA for multi-turn
tool execution) had a chain of results that *each looked stable* but
combined into a misleading picture. Three rounds of `evals-runner`
ablation under `examples/benchmarks/multi-turn-scaffold-ablation.mjs`
unwound it:

| Round | Finding | What changed |
|------|---------|--------------|
| 1 — `arm-f` vs `bare` | arm-f 41.1% [31.5, 51.4] vs bare 12.2% [7.0, 20.6], McNemar p = 2.6 × 10⁻⁶ | Confirmed grammar-pinned tool calling is a +28.9pp lift on this model class. |
| 2 — `arm-batch-grammar` (new) vs both | batch-grammar 14.4% [8.6, 23.2] << arm-f 38.9% | **Falsified** the assumption that "give the model the full plan in one call" would help. The Pick/Provide split in arm-f turns out to be an *asset*, not a cost. |
| 3 — Sanity recheck | Round-2 bare regressed to 6.7%; the bare-wins=3 from round 1 didn't reproduce. | The 3 cells we'd built a hypothesis on were sampling noise, not a stable failure mode of arm-f. |

**Without paired McNemar** the round-1 → round-2 reversal could have
been read as *progress* (training data strategy looks promising). With
paired McNemar against the same item set, the noise floor is visible:
[`docs/reports/arm-f-vs-bare-2026-06-17/`](https://github.com/WasmAgent/wasmagent-js/tree/main/docs/reports/arm-f-vs-bare-2026-06-17)
and [`docs/reports/arm-batch-grammar-2026-06-17/`](https://github.com/WasmAgent/wasmagent-js/tree/main/docs/reports/arm-batch-grammar-2026-06-17).

Reproduce on your own machine (Ollama + any small model, no cloud
budget):

```sh
node examples/benchmarks/multi-turn-scaffold-ablation.mjs \
  --base-url http://localhost:11434/v1 \
  --models <your-model-tag> \
  --arms bare,param-only,batch-grammar \
  --seeds 0,1,2 \
  --concurrency 1 --no-warmup \
  --out docs/reports/your-run
```

This is the harness positioning: not "we have the highest LongMemEval
number," but "we are the harness anyone can re-run on any pair of
agents under paired statistics." The 2026-06-17 chain above is the
worked example — the falsification of round 2 is **what we want
people to be able to do with their own models, fast**.
