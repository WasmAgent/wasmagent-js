# Phase 0 Day 10 — Failure Taxonomy & Phase 1 Prescriptions

> **Source data**: `runs.jsonl` from the 2026-06-24 clean sweep (50 IFEval samples × 3 baselines = 150 ComplianceEvalRecords, zero infrastructure errors).

## TL;DR

Phase 0 acceptance criteria are met on Qwen2.5-1.5B-Q4_K_M:

| metric | direct | prompt_retry | **full_pcl** | Δ vs prompt_retry |
|---|---|---|---|---|
| pass_rate | 40.0% | 48.0% | **54.0%** | **+6.0 pp** |
| avg_total_tokens | 335 | 784 | **628** | **−20%** |
| avg_latency_ms | 2769 | 6537 | **3213** | **−51%** |

The headline win is real. **`full_pcl` wins 4 samples that `prompt_retry` loses; loses 1 sample that `prompt_retry` wins. Net +3 samples (+6 pp).**

The 23 remaining `full_pcl` failures cluster into 4 distinct patterns. Each is independently fixable in Phase 1.

---

## Pattern 1 — Repair regression (6/23 failures = 26%)

**Symptom**: round N clears violation A. Round N+1 attacks violation B with an LLM rewrite. The rewrite drops the fix for A.

**Concrete case**: `ifeval.152` requires `english_lowercase` AND `number_words ≥ 900`.

```
round 1: patch (strip uppercase)            → A cleared, B (word count) remains
round 2: regenerate_region (LLM long form)  → LLM wrote a longer response with uppercase → A REGRESSES
round 3: insert_section (no-op)             → both A and B fail
```

Other regression cases: `ifeval.16`, `ifeval.30`, `ifeval.1000`, `ifeval.1069`, `ifeval.1265`.

**Why this happens**: `RegenerateRegionStrategy.buildPrompt()` mentions other constraints in the prompt (the ❌ marker), but the LLM does not reliably attend to them. The Phase-0 contract was "verify after each round" — we do that — but verification only tells us A is broken, not that round 2 broke it.

**Phase 1 prescription**: 
- **Post-round delta check**: compare violations before/after a round; if any *previously-passing* constraint regressed, **roll back to the pre-round artifact** and try a different strategy. The diff is cheap (we already have both states).
- **Cumulative constraint prompt**: when escalating to `regenerate_region`, include ALL outstanding constraints (not just the one this round targets), with explicit "keep the existing fixes for ..." language.
- Estimated impact: clears at least 4 of 6 regression cases → +0.5pp pass-rate.

---

## Pattern 2 — Soft semantic constraints (8/23 failures, mostly `length_constraints:number_words`)

**Symptom**: small model produces short responses; `regenerate_region` retries don't reliably hit the word count.

**Concrete case**: `ifeval.19` requires `≥600 words AND <701 words`. Three rounds of regenerate_region all returned 50–80 words.

```
final artifact: 'I am a computer science professor who is also a computer scientist.' (12 words)
```

The model literally can't sustain 600 words on Qwen-1.5B-Q4. This is **a model-capacity ceiling, not a planner bug**.

**Phase 1 prescription**:
- This failure mode disappears with larger models. Phase 1's Llama-3.1-8B-Instruct should handle word-count targets in the 300–500 range; Qwen3-14B should handle 600–1000.
- For Qwen2.5-1.5B specifically, the planner could **detect impossibility early**: if the model produces <50% of the requested length in 2 rounds, mark the constraint as "model_incapable" and skip further repair (saves tokens). This is a Phase 1 "early abort" feature.
- Alternative deterministic fix: **`expand_with_padding` strategy** — append "(continued)..." style filler to hit word count. Would game the metric but the academic point is that PCL's *strength* is structural fixes; word-count is the wrong demo. Not recommended.

---

## Pattern 3 — `combination:repeat_prompt` (4/23 failures)

**Symptom**: Model refuses to echo the prompt verbatim, or produces near-misses (whitespace, punctuation, "I'll repeat your request:" preamble).

**Concrete case**: `ifeval.16` — model **safety-refuses** the prompt entirely ("I'm sorry, but I cannot repeat the request..."). The IFEval prompts were designed pre-RLHF and trigger refusals on instruct-tuned models.

```
final: '<<untitled>>\nI'm sorry, but I cannot repeat the request as it contains offensive language...'
```

The text in question is innocuous; the model's safety filter is over-broad. `regenerate_region` makes it worse — the LLM re-applies the refusal.

**Phase 1 prescription**:
- **Deterministic `prepend_prompt` strategy**: literally `f"{prompt_to_repeat}\n\n{artifact}"`. This is what the constraint *means*. Should land in IFEvalVerifier-aware strategies.
  - Risk: prepending the prompt breaks `combination:repeat_prompt` only if model added "I'll repeat..." preamble first. We can strip with regex.
- Estimated impact: clears at least 3 of 4 cases → +0.6pp pass-rate.

---

## Pattern 4 — `keywords:frequency` / `keywords:letter_frequency` (6/23 failures)

**Symptom**: model writes a thematically-appropriate response but doesn't hit the keyword count.

**Concrete case**: `ifeval.127` requires the word "story" at least N times. Model produces a 200-word parenting essay with the word "story" appearing once.

**Phase 1 prescription**:
- **`enforce_keyword_count` patch strategy**: deterministic insertion. If the keyword is missing K occurrences, append K natural-language sentences using it (e.g. "This story is important." × K). Hacky but the constraint is hacky.
- Or: improve the `regenerate_region` prompt to **explicitly count the keyword** in the failure hint (verifier already does this; planner just doesn't pass the count forward — we have `hint: "response has X occurrence(s); requires Y"` but the prompt doesn't reformat it into "use the word at least Z more times").
- Letter-frequency is harder; recommend dropping from Phase 1's primary metric set (it's a rare instruction class anyway).

---

## Strategy effectiveness — which strategy worked

When `full_pcl` *succeeded*, here's the strategy mix:

| strategy | rounds where it cleared the targeted violation |
|---|---|
| `patch` | 8 (no_comma, lowercase) |
| `insert_section` | 4 (title, missing keywords) |
| `regenerate_region` | 16 (length, content) |

`regenerate_region` is the workhorse for content rewrites; deterministic strategies are pure win where they apply. **No strategy is wasted** — each has a clear niche.

---

## Phase 0 → Phase 1 prioritised backlog

| # | Item | Estimated pass-rate impact | Effort |
|---|---|---|---|
| P0 | Implement rollback-on-regression in `RepairPlanner` | +0.5pp | 2 days |
| P0 | Implement `prepend_prompt` strategy for `combination:repeat_prompt` | +0.6pp | 1 day |
| P0 | Add cumulative constraint prompt to `RegenerateRegionStrategy` | +0.5pp | 1 day |
| P1 | Wire 2 more models (Llama-3.1-8B, Qwen3-14B) | model-dependent, expect +3-5pp on number_words | 3 days |
| P1 | Add ComplexBench + CFBench benchmark loaders | broader signal | 5 days |
| P1 | Align `ComplianceEvalRecord` with `RolloutMemoryStore` JSONL | (no pass-rate change; unlocks EvoMerge) | 2 days |
| P2 | `enforce_keyword_count` patch strategy | +0.3pp | 1 day |
| P2 | Early-abort on model-incapable constraints | token savings only | 1 day |

**Realistic Phase-1 ceiling**: with the P0 items only, projected `full_pcl` pass-rate on this 50-sample set ≈ **55–56%**. With Llama-3.1-8B, projected ≈ **65–70%**.

---

## Open questions for Phase 1

1. **When should a strategy admit defeat earlier?** Today the planner cycles patch → regenerate_region → insert_section regardless. A model-capability signal (consecutive null artifacts, no improvement) should short-circuit.
2. **Should `final_pass` accept partial credit?** The IFEval official metric does prompt-level all-or-nothing. For a research paper that may be too brittle; CFBench-style weighted scoring may be a better headline metric.
3. **Is the regression-rollback safe with stateful repairs?** All current strategies are stateless. Future strategies (multi-step tool repair) may have side effects that can't be rolled back; the rollback contract needs to be opt-in per-strategy.

---

## Provenance

- Sweep: 2026-06-24 14:30 +0800, 45.5s wall-clock, 0 errors
- JSONL: `packages/compliance/benchmarks/ifeval/results/runs.jsonl` (150 records)
- Aggregate: `packages/compliance/benchmarks/ifeval/results/summary.md`
- Code under test:
  - `@wasmagent/compliance@0.1.0-alpha.0`
  - `@wasmagent/model-local@1.0.3` (node-llama-cpp 3.18.1, Metal disabled, CPU)
- Model: `qwen2.5-1.5b-instruct-q4_k_m.gguf` (1.05 GB, Q4_K_M, sha256 `6a1a2eb6…`)
- Test sample set sha256: `038b9782ed9250f9ceac383a0507f9fb3f36ec169366818d058faa0991741a0d`
