# Evals Cookbook

agentkit-js ships 12+ scorers covering correctness, faithfulness,
relevance, efficiency, constraints, recovery, guardrail compliance,
and LLM-as-judge. This guide shows how to combine them for production-
grade benchmarking.

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
| `llmJudge` | async | Custom LLM-judged rubric |
| `faithfulnessScorer` | async | Hallucination detection vs. tool outputs |
| `relevanceScorer` | async | Embedding cosine vs. expected answer |

## Quick start

```ts
import { runEval, exactMatch, toolCallAccuracy, trajectoryValidity } from "@agentkit-js/core";

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
import { compositeScorer, exactMatch, efficiencyScorer, recoveryScorer } from "@agentkit-js/core";

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
import { faithfulnessScorerAsync, collectTrace } from "@agentkit-js/core";

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
import { relevanceScorerAsync } from "@agentkit-js/core";
import { HttpEmbedder } from "@agentkit-js/tools-rag";

const embedder = new HttpEmbedder({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "text-embedding-3-small",
});

const result = await relevanceScorerAsync({ embedder }, trace, sample);
// result.score is cosine similarity in [0, 1]
```

## Constraints (must / must-not)

```ts
import { constraintScorer } from "@agentkit-js/core";

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
import { efficiencyScorer } from "@agentkit-js/core";

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
import { recoveryScorer } from "@agentkit-js/core";

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
