# Evals Cookbook

wasmagent-js ships 15 scorers covering correctness, faithfulness,
relevance, efficiency, constraints, recovery, guardrail compliance,
and LLM-as-judge. This guide shows how to combine them for production-
grade benchmarking.

> **Looking for the multi-model harness?** See
> [`@wasmagent/evals-runner`](./evals-runner.md) — uses these same
> scorers to drive multi-model × multi-suite × multi-seed Pareto
> reports with built-in paired statistics. The cookbook below covers
> the per-trace scorer API; the runner sits on top.

## Available scorers

| Scorer | Sync? | Use case |
|--------|-------|----------|
| `exactMatch` | sync | Deterministic answer match |
| `toolCallAccuracy` | sync | Correct tool sequence (LCS-based) |
| `trajectoryValidity` | sync | Tool calls paired with results |
| `finalAnswerLength` | sync | Length within target |
| `efficiencyScorer` | sync | Token / cost / duration / step budgets |
| `constraintScorer` | sync | Hard rules (must use tool X, must contain Y) |
| `recoveryScorer` | sync | Recovery rate from tool failures |
| `compositeScorer` | sync | Weighted blend of sub-scorers |
| `guardrailCompliance` | sync | Output guardrail trip-wires |
| `llmJudge` | async | Custom LLM-judged rubric (coarse 0/0.5/1 scale) |
| `judgeScorer` (A4) | async | Multi-criterion LLM judge with weighted breakdown |
| `trajectoryQualityJudge` (A4) | async | Built-in: efficiency + tool-fit + self-correction |
| `answerCompletenessJudge` (A4) | async | Built-in: coverage + actionability + honesty |
| `faithfulnessScorer` | async | Hallucination detection vs. tool outputs |
| `relevanceScorer` | async | Embedding cosine vs. expected answer |

## Quick start

```ts
import { runEval, exactMatch, toolCallAccuracy, trajectoryValidity } from "@wasmagent/core";

const dataset = [
  { id: "1", task: "What is 2+2?", expectedAnswer: "4" },
  { id: "2", task: "Search for X", expectedTools: ["web_search"] },
];

const results = await runEval(dataset, (task) => agent.run(task), [
  exactMatch,
  toolCallAccuracy,
  trajectoryValidity,
]);
```

## Composite scoring

Combine multiple dimensions into one blended metric:

```ts
import { compositeScorer, exactMatch, efficiencyScorer, recoveryScorer } from "@wasmagent/core";

const overall = compositeScorer([
  { scorer: exactMatch, weight: 0.5 },
  { scorer: efficiencyScorer({ maxTokens: 5000, maxCostUsd: 0.05 }), weight: 0.3 },
  { scorer: recoveryScorer(), weight: 0.2 },
]);
```

## Hallucination detection (async)

The faithfulness scorer needs an LLM judge — call its async variant
from your eval runner:

```ts
import { faithfulnessScorerAsync, collectTrace } from "@wasmagent/core";

const events = [];
for await (const ev of agent.run(task)) events.push(ev);
const trace = collectTrace(task, events);

const result = await faithfulnessScorerAsync(
  { model: judgeModel, maxTokens: 32 },
  trace
);
console.log(`Faithfulness: ${result.score} — ${result.detail}`);
```

Use a cheap fast model (Haiku, GPT-4o-mini, DeepSeek V4 Flash) as the
judge to keep evals affordable.

## Relevance via embeddings

```ts
import { relevanceScorerAsync } from "@wasmagent/core";
import { HttpEmbedder } from "@wasmagent/tools-rag";

const embedder = new HttpEmbedder({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "text-embedding-3-small",
});

const result = await relevanceScorerAsync({ embedder }, trace, sample);
// result.score is cosine similarity in [0, 1]
```

## Constraints (must / must-not)

```ts
import { constraintScorer } from "@wasmagent/core";

const safetyCheck = constraintScorer({
  mustContain: ["disclaimer:"],
  mustNotContain: ["password", "secret"],
  mustUseTool: ["safety_check"],
  mustNotUseTool: ["delete_file"],
  maxLength: 2000,
});
```

Returns 1 only when ALL constraints are met; 0 otherwise. Pair with
compositeScorer to balance with continuous metrics.

## Efficiency

`efficiencyScorer` extracts token usage from `model_done` events,
duration from event timestamps, and step count from `step_start` events.

```ts
import { efficiencyScorer } from "@wasmagent/core";

const eff = efficiencyScorer({
  maxTokens: 10_000,
  maxDurationMs: 30_000,
  maxCostUsd: 0.10,
  maxSteps: 20,
});
```

Score = geometric mean of dimensions. A 0 in any dimension drives
total to 0.

## Recovery

How well does the agent bounce back from tool failures?

```ts
import { recoveryScorer } from "@wasmagent/core";

// score = recoveries / total failures
// 1.0 = recovered from every failure
// 0.0 = no recovery
// 1.0 vacuously when there were no failures
```

## Designing a real benchmark

Recommended composite for production agents:

```ts
const benchmark = compositeScorer(
  [
    { scorer: exactMatch, weight: 0.30 },          // hard correctness
    { scorer: toolCallAccuracy, weight: 0.15 },    // followed expected workflow
    { scorer: trajectoryValidity, weight: 0.10 },  // no orphaned tool calls
    { scorer: efficiencyScorer({ maxTokens: 8000, maxCostUsd: 0.05 }), weight: 0.20 },
    { scorer: recoveryScorer(), weight: 0.10 },
    { scorer: constraintScorer({ mustNotContain: ["I cannot"] }), weight: 0.15 },
  ],
  "production-quality",
);
```

Run async scorers (faithfulness, relevance) separately and fold their
results in manually if you need the full async path.

## A4 — multi-criterion LLM judges

`judgeScorer` is the richer sibling of `llmJudge`. It accepts a list of
criteria, each with optional weights, and returns a per-criterion
breakdown alongside the composite score. Two built-in domain judges
(`trajectoryQualityJudge`, `answerCompletenessJudge`) ship with
sensible defaults so you can start grading without authoring rubrics.

```ts
import {
  answerCompletenessJudge,
  runJudgeScorer,
  trajectoryQualityJudge,
} from "@wasmagent/core";

// Cheap judge — Haiku / Doubao / DeepSeek all work; the agent stays on Sonnet.
const judgeModel = new HaikuModel({ apiKey: process.env.ANTHROPIC_API_KEY });

const completeness = await runJudgeScorer(
  trace,
  answerCompletenessJudge(judgeModel),
);

console.log(completeness.score);             // 0..1 weighted composite
console.log(completeness.breakdown);         // per-criterion raw + normalized + reasoning
```

### Custom criteria

Pass `criteria` to override the defaults. Weights are optional and
normalised so they always sum to 1; zero-weight criteria are graded
but excluded from the composite.

```ts
const reviewerJudge = judgeScorer({
  name: "code-review",
  model: judgeModel,
  scale: 5,                            // 0–5 scoring instead of 0–10
  systemPersona: "You are a senior reviewer at FinCorp.",
  generateOpts: { temperature: 0 },
  criteria: [
    { id: "correctness",  description: "Does the patch fix the bug?",       weight: 4 },
    { id: "tests",        description: "Did the patch add or update tests?", weight: 2 },
    { id: "style",        description: "Does the patch follow the repo conventions?", weight: 1 },
  ],
});
```

### Why a separate type from `llmJudge`?

`llmJudge` returns a 0/0.5/1 verdict. That's enough for binary
"passed/failed" decisions but loses signal — an answer that's 70%
correct collapses to the same bucket as 49%. JudgeScorer keeps the
nuance via per-criterion grading and a configurable scale. Pick
`llmJudge` for smoke tests, `judgeScorer` for production benchmarks.

### Pairing rule-based and judge scorers

The two complement each other. Rule-based scorers are cheap,
deterministic, and anchor the dashboard. Judges add nuance the rules
can't pattern-match (eg "the answer mentions every required topic but
glosses over half of them"). The
[`judge-scorer-demo`](../../examples/judge-scorer-demo/) example shows
the divergence on a synthetic trace.
