# Evaluation runner — wasmagent-js as a model-evaluation harness

> **Status**: shipped in `@wasmagent/evals-runner@1.0.0` (2026-06-12).
> Provider-agnostic OpenAI-compat: point at Ollama / OpenRouter /
> AI Gateway / OpenAI / vLLM. Same model-spec format as the rest of
> wasmagent-js (`docs/guides/openai-compat-recipes.md`).

## What it does

Takes a list of models + a list of benchmark suites + a list of seeds,
runs the full Cartesian product, and emits a Pareto-flagged markdown
report. The 5-model LongMemEval comparison in
[`docs/benchmarks.md`](../benchmarks.md#longmemeval-style-end-to-end-across-5-local-models-2026-06-12)
is a worked example — the runner replaces the bash-loop + manual table
build that produced it.

## CLI

```bash
# Pick a suite from the catalogue:
wasmagent evals list

# Run multi-turn memory across 5 local Ollama models, 3 seeds:
wasmagent evals run \
  --suite=multi-turn-memory \
  --models="qwen2.5:0.5b,evo-qwen3-1b7-q3km:latest,evomerge-qwen25-1b5:latest,evomerge-qwen3-v2:latest,gemma4-12b:latest" \
  --base-url=http://localhost:11434/v1 \
  --seeds=0,1,2 \
  --report-file=./eval.md
```

The `--models` value is a comma-separated list of `id@baseUrl#modelId`
specs. `@baseUrl` and `#modelId` are both optional — `id` doubles as
the wire-level model name when `#modelId` is absent, and `--base-url`
provides a fallback for specs that omit `@`.

Bilateral specs (different base URLs per model) work the same way:

```bash
wasmagent evals run \
  --suite=multi-turn-memory \
  --models="qwen2.5:0.5b@http://localhost:11434/v1,gpt4o-mini@https://api.openai.com/v1#gpt-4o-mini"
```

## Six reference suites

| Suite                    | What it measures                                                            |
| ------------------------ | --------------------------------------------------------------------------- |
| `multi-turn-memory`      | 6-item LongMemEval-style multi-session recall                               |
| `long-context-recall`    | Needle-in-haystack at 10% / 50% / 90% depth in ~16K-token filler            |
| `cost-per-correct`       | Same items as multi-turn-memory; metric is USD per passing answer           |
| `tool-sequence`          | 3-step JSON tool-call plans matched against expected order                  |
| `agent-trajectory`       | Plan + reasoning emission scored by trajectory validity + length            |
| `latency-under-budget`   | Multi-turn memory under a 2 s wall + 256-token-output budget                |

**All six suites use synthetic / hand-built items.** None of them overlap
with publicly published training corpora (GSM8K, MMLU, IFEval,
HumanEval, Alpaca, etc.). This is a deliberate data-hygiene choice —
the gates academia ships as benchmarks are also the corpora most
fine-tunes train on, which silently inflates accuracy without telling
you.

If you need the academic benchmarks for compliance, run them with
[`lm-evaluation-harness`](https://github.com/EleutherAI/lm-evaluation-harness)
and import the JSON. This package focuses on axes those benchmarks
don't cover.

## Pareto-first reporting

The summary table flags each (model, suite) cell as on the Pareto front
when no other model has at least its accuracy AND lower-or-equal cost
AND lower-or-equal p95 wall, with at least one strict win. This is the
information you actually need to pick a model — single-number accuracy
ranks are noise compared to the trade-off surface.

Worked example: in the 5-model LongMemEval run, the 0.94 GB Q3_K_M
model and the 4.12 GB FP16 model both reached 5/6 = 83% accuracy. Pareto
flags the 0.94 GB model on the front (same accuracy, lower memory
footprint, similar latency). The accuracy-only table the academic gates
ship would give you no way to see this.

## Statistical discipline built in

Every report includes:

- Pooled-across-seeds accuracy ± 95% Wilson CI
- σ across seeds (high σ = result is noisy, claim is unreliable)
- Pooled paired-McNemar p-value when comparing against a baseline

The `buildG1Report` API (also exported from `@wasmagent/evals-runner`)
matches the ≥3-seed discipline used in serious model-evaluation work:
single-seed greedy point estimates do not constitute evidence.

## Programmatic API

```ts
import { runEvaluation, multiTurnMemorySuite, renderReportMarkdown } from "@wasmagent/evals-runner";

const report = await runEvaluation({
  models: [
    { id: "qwen", baseUrl: "http://localhost:11434/v1", modelId: "qwen2.5:0.5b" },
    { id: "gpt", baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY,
      modelId: "gpt-4o-mini", pricePer1MInput: 0.15, pricePer1MOutput: 0.60 },
  ],
  suites: [multiTurnMemorySuite],
  seeds: [0, 1, 2],
});

await fs.writeFile("eval.md", renderReportMarkdown(report));
```

The `report` carries `cells` (per-(model, seed, item) results),
`aggregates` (per-(model, suite) rollups), and `pareto` (per-suite
non-dominated front). All three are exposed so consumers can build their
own dashboards.

## Bring your own suite

```ts
import type { BenchmarkSuite } from "@wasmagent/evals-runner";
import { exactMatch } from "@wasmagent/core";

const myBenchmark: BenchmarkSuite = {
  name: "my-domain-suite",
  title: "Customer support QA recall",
  description: "Internal tickets — not in any training set",
  items: [
    { id: "T1", task: "What's the SLA on premium plans?", expectedAnswer: "4 hours" },
    // …
  ],
  scorers: [exactMatch],
};

await runEvaluation({ models, suites: [myBenchmark] });
```

The 10 scorers shipped in `@wasmagent/core/evals` (`exactMatch`,
`toolCallAccuracy`, `trajectoryValidity`, `efficiencyScorer`,
`constraintScorer`, `recoveryScorer`, `faithfulnessScorerAsync`,
`relevanceScorerAsync`, `compositeScorer`, plus `JudgeScorer`) all work
unchanged.

## See also

- [`packages/evals-runner/README.md`](../../packages/evals-runner/README.md) —
  package-level details, install, full API.
- [`docs/guides/openai-compat-recipes.md`](./openai-compat-recipes.md) —
  Ollama / OpenRouter / AI Gateway / DeepSeek / Groq recipes.
- [`docs/benchmarks.md`](../benchmarks.md) — the canonical ratio table
  this runner extends.
