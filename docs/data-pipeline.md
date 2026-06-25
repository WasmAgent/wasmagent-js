---
title: Data Pipeline
description: Complete guide to the wasmagent → trace-pipeline RLAIF training data pipeline.
---

# Data Pipeline: Runtime → Data Factory

This page explains the full pipeline from agent execution in wasmagent-js to
DPO/PPO training records in trace-pipeline. No LLM calls are required to understand
or test this pipeline — all contracts are verifiable with fixtures.

## Pipeline layers

```
wasmagent-js                          trace-pipeline
─────────────────────────────────     ─────────────────────────────
RolloutForkRunner.run()               datafactory/exporter.py
  branches: N independent agents  ─▶  load_rollouts(path)
  tool_call_sequence per branch        → list[RolloutRecord]
  final_answer per branch
  ↓ serialize to JSONL                 to_dpo()
  Layer 1: RolloutBranchRecord    ─▶  → list[DpoRecord] (messages, chosen, rejected)

RolloutRanker.rank()                   to_ppo()
  objectiveScore (BuildPasses)    ─▶  → list[PPORecord] (messages, reward ∈ [0,1])
  judgeScore (LLMJudge, optional)
  totalScore = weighted sum            export(records, dpo_path, ppo_path)
  ↓                                    → writes DPO + PPO JSONL files
  ranked: RankedBranch[]
  ↓
toDpoRecord() / toPpoRecords()    Layer 2 (optional — direct TypeScript consumer)
  → DpoRecord / PpoRecord
  → toJsonl()
```

## Layer 1: RolloutBranchRecord

Written by `RolloutForkRunner`, read by `evomerge load_rollouts()`.

Schema: [`packages/core/src/ranking/schemas/rollout-wire.schema.json`](./schemas/GOVERNANCE.md)

Required fields:

| Field | Type | Description |
|---|---|---|
| `rollout_id` | string | Stable ID for this rollout run |
| `task` | string | The user task string |
| `branch_index` | integer ≥ 0 | Which fork (0-based) |
| `temperature` | number | Sampling temperature used |
| `session_id` | string | bscode session for build result lookup |
| `tool_call_sequence` | object[] | `tool_call` + `tool_result` events |
| `final_answer` | string | Agent's final answer text |
| `objective_score` | 0 \| 1 | 1 = build passes, 0 = fails |
| `rank` | integer | Rank among branches (1 = best) |
| `total_score` | number | Raw RolloutRanker score (NOT normalised to [0,1]) |

## Layer 3: Training Records (Python output)

`TrainingDataExporter` rebuilds messages in OpenAI tool-calls format and
normalises the reward to [0, 1] for downstream training.

**DPO record fields:**

| Field | Description |
|---|---|
| `messages` | Full conversation including tool calls (apply_chat_template compatible) |
| `prompt_messages` | Messages up to (not including) the final assistant turn |
| `chosen` | Best branch's final answer |
| `rejected` | Worst branch's final answer |
| `loss_weight_tokens` | `"default"` \| `"recovery"` \| `"state_summary"` |
| `provenance.source` | Always `"wasmagent-rollout"` |
| `provenance.rollout_id` | Matches Layer 1 `rollout_id` |
| `provenance.task_hash` | `sha256(task)[:16]` for deduplication |

**PPO record fields:**

| Field | Description |
|---|---|
| `messages` | Same format as DPO |
| `reward` | Normalised score ∈ [0, 1]: `min(1, totalScore / 1.3)` |
| `loss_weight_tokens` | Same as DPO |
| `provenance` | Same fields as DPO |

## Scoring

```
totalScore = objective × 1.0 + (judgeScore / 10) × 0.3

objective  = 1 if all criteria pass (BuildPassesVerifier, VisualAssertVerifier, …)
           = 0 otherwise

judgeScore = ScalarLLMJudgeVerifier score 0–10
           = 5 (neutral) when no LLM judge is configured
```

`MAX_TOTAL = 1.3` so a perfect run (`objective=1, judge=10`) normalises to `reward=1.0`.

## G3 provenance check

Before exporting, `TrainingDataExporter.validate_g3()` checks that rollout task
strings have zero n-gram overlap with the eval set. This prevents training data
from contaminating evaluation metrics.

```bash
python -m datafactory \
  --input rollouts.jsonl \
  --eval-items eval_items.jsonl \
  --output-dpo dpo.jsonl \
  --output-ppo ppo.jsonl
```

To skip during development (not recommended for production exports):

```bash
python -m datafactory --input rollouts.jsonl --allow-missing-g3
```

## Smoke testing the pipeline

A fixture-based smoke test validates the full pipeline without any LLM calls:

```bash
# From trace-pipeline repo root
python3 tests/test_three_repo_smoke.py
```

This test:
1. Creates synthetic `RolloutBranchRecord` JSONL (2 branches, branch 0 passes build)
2. Calls `load_rollouts()` and validates field parsing
3. Calls `export()` to produce DPO + PPO records
4. Validates all required fields and reward ordering
5. Checks that `rollout-wire.schema.json` is identical between wasmagent-js and trace-pipeline

The TypeScript side of the pipeline is tested in:
`wasmagent-js/tests/integration/rlaif-pipeline.test.ts`

## Schema governance

The canonical schema owner is `wasmagent-js`. When fields change:

1. Update `packages/core/src/ranking/schemas/rollout-wire.schema.json`
2. Update `packages/core/src/ranking/RolloutExporter.ts` types
3. Copy schema to `trace-pipeline/src/datafactory/rollout-wire.schema.json`
4. Update `trace-pipeline/src/datafactory/exporter.py` to match
5. Run `python3 tests/test_three_repo_smoke.py` — the cross-repo diff step will catch any drift

See [Schema Governance](./schemas/GOVERNANCE.md) for the full change process.
