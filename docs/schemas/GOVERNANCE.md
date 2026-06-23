# Schema Governance — wasmagent ↔ evomerge Data Pipeline

## Overview

Three repositories exchange data through JSONL files. This document defines
the single source of truth for each format and the process for changing it.

## Data pipeline layers

```
wasmagent-js RolloutForkRunner
  │  produces RolloutBranchResult (in-memory)
  │
  ▼  serialized to JSONL
Layer 1: RolloutBranchRecord (rollout-wire.schema.json § RolloutBranchRecord)
  │  fields: rollout_id, task, branch_index, temperature, session_id,
  │          tool_call_sequence, final_answer, objective_score, rank, total_score
  │
  ▼  consumed by evomerge load_rollouts()
  │  OR processed by wasmagent-js toDpoRecord() / toPpoRecords()
  │
Layer 2: DpoRecord / PpoRecord (rollout-wire.schema.json § DpoRecord / PpoRecord)
  │  fields: prompt, chosen/completion, reward, tool_call_sequence, provenance
  │  provenance.source: "wasmagent-rollout"  ← canonical constant
  │  provenance fields: snake_case throughout
  │
  ▼  consumed by evomerge exporter.py to_dpo() / to_ppo()
  │  (rebuilds messages, infers loss_weight, normalizes reward to [0,1])
  │
Layer 3: Training Record (training-record.schema.json)
  │  fields: messages, chosen/reward, loss_weight_tokens, provenance
  │  validated by validate-rlaif.mjs before shipping to training
  │
  ▼  consumed by training framework (Hugging Face Trainer)
```

## Schema files (single source of truth)

| File | Location (canonical) | Mirror |
|------|----------------------|--------|
| `rollout-wire.schema.json` | `wasmagent-js/packages/core/src/ranking/schemas/` | `evomerge/datafactory/` |
| `training-record.schema.json` | `wasmagent-js/packages/core/src/ranking/schemas/` | `evomerge/datafactory/` |

The **canonical copy** lives in `wasmagent-js`. The evomerge copies are
mirrors that must be kept in sync manually (verified by CI).

## Schema owner

The `wasmagent-js` team owns the schema. Breaking changes require coordination
before merging.

## Change process

### Adding a new field (non-breaking)

1. Update the Zod interface in `RolloutExporter.ts` (add the field).
2. Update `rollout-wire.schema.json` or `training-record.schema.json` as appropriate.
3. Run `node scripts/check-rollout-schema.mjs` locally — must pass.
4. Open PR in `wasmagent-js`. CI will verify schema consistency.
5. After merge, copy updated schema file(s) to `evomerge/datafactory/`.
6. Update `exporter.py` to consume the new field if needed.
7. Run `python scripts/check-schema-fields.py` in evomerge — must pass.

### Renaming or removing a field (breaking)

Update **consumers first, producer last**:

1. Update `evomerge/exporter.py` to handle both old and new field names (or
   remove the old name from its reads).
2. Update `bscode/apps/worker/src/rollout-adapter.ts` if it references the field.
3. After both consumer PRs are merged, update the producer (`RolloutExporter.ts`)
   and the schema files.
4. Remove the compatibility shim from consumers.

### Changing provenance.source constant

The constant `"wasmagent-rollout"` appears in:
- `RolloutExporter.ts` (TypeScript literal type + runtime value)
- `rollout-wire.schema.json` ($.defs.DpoProvenance.properties.source.const)
- `training-record.schema.json` ($.defs.Provenance.properties.source.const)
- `evomerge/datafactory/exporter.py` (_make_provenance)
- `evomerge/datafactory/validate-rlaif.mjs` (read from schema, not hardcoded)

If it must change, update all five locations atomically.

## CI enforcement

### wasmagent-js (`scripts/check-rollout-schema.mjs`)

Runs in CI after lint. Checks:
- `RolloutExporter.ts` provenance objects use snake_case keys only
- Schema JSON files are present and valid
- Schema `provenance.source.const` is `"wasmagent-rollout"`

### evomerge (`scripts/check-schema-fields.py`)

Runs in CI under the `boundaries` job. Checks:
- `exporter.py load_rollouts()` reads all fields required by `RolloutBranchRecord`
- `exporter.py _make_provenance()` uses the source constant from the schema
- Schema JSON files are present and valid
- All provenance field names in the schema are snake_case

## Conventions

- **Field naming**: snake_case in all JSONL wire formats and schema files.
  TypeScript internal identifiers (function parameters, local variables) may
  use camelCase, but the serialized JSON keys must be snake_case.
- **reward normalization**: `total_score` in Layer 1/2 is raw (may exceed 1.0).
  Normalization to `[0, 1]` is evomerge's responsibility (`_compute_reward()`).
  Do not normalize in `toPpoRecords()`.
- **n_gram_hash**: 16-hex-character SHA-256 prefix of the task string. Computed
  in `toDpoRecord()`/`toPpoRecords()` using `node:crypto`. Used by the G3 gate
  in evomerge to detect eval contamination.
- **prompt_messages**: Optional field on `DPORecord` (Training Record layer 3).
  Contains the conversation history up to (not including) the final assistant turn,
  enabling TRL `DPOTrainer` to receive a distinct `prompt` and `chosen`/`rejected`
  pair without double-counting prompt tokens in the loss. Generated by
  `evomerge/datafactory/exporter.py _extract_prompt_messages()`.

## Training scripts

| Script | Method | Input |
|---|---|---|
| `evomerge/scripts/p17_b1_sft.py` | SFT (supervised fine-tuning) | `messages` JSONL |
| `evomerge/scripts/p18_grpo_train.py` | GRPO (group relative policy optimization) | PPORecord JSONL from `exporter.py` |

`p18_grpo_train.py` reads the `reward` field from PPORecord (already normalized to [0, 1])
and passes it to `trl.GRPOTrainer` via a reward function. LoRA is on by default (rank 16).
Requires `pip install trl>=0.9 peft transformers torch`.

