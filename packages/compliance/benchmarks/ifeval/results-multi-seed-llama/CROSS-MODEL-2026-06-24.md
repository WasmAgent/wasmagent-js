# IFEval Cross-Model Results — Qwen2.5-1.5B vs Llama-3.2-1B (2026-06-24)

> **Status**: Multi-seed (N=3) sweeps on two 1-1.5B open-source models. Key finding: **PCL's value depends on the base model.** Net win against `direct` is consistent (+11 to +13 pp). Net win against `prompt_retry` is model-dependent: large on Qwen (+8.7 pp), zero on Llama (−0.7 pp).

## Headline (mean ± stddev across 3 seeds)

| mode | Qwen2.5-1.5B | Llama-3.2-1B |
|---|---|---|
| direct       | 41.3% ± 3.1 | 47.3% ± 4.6 |
| prompt_retry | 46.0% ± 2.0 | **59.3% ± 5.8** |
| **full_pcl** | **54.7% ± 1.2** | 58.7% ± 1.2 |

### Δ `full_pcl` vs `prompt_retry`

| | seed=42 | seed=43 | seed=44 | mean ± std |
|---|---|---|---|---|
| Qwen  | +6.0 | +12.0 | +8.0 | **+8.7 ± 3.1** |
| Llama | −8.0 | +2.0 | +4.0 | **−0.7 ± 6.4** |

### Δ `full_pcl` vs `direct`

| | seed=42 | seed=43 | seed=44 | mean ± std |
|---|---|---|---|---|
| Qwen  | +10.0 | +14.0 | +16.0 | **+13.3 ± 3.1** |
| Llama | +8.0 | +16.0 | +10.0 | **+11.3 ± 4.2** |

## The interesting story

PCL gives one **unambiguous** benefit on both models, and one **model-dependent** benefit:

### Unambiguous: PCL strictly dominates `direct`
- Pairwise across all (seed, sample) pairs:
  - Qwen: `full_pcl` 20 wins, 0 losses vs `direct`
  - Llama: `full_pcl` 17 wins, 0 losses vs `direct`
- **Repair never harms a passing run on either model.** This is the monotonicity property the design promises — empirically validated on both.

### Model-dependent: PCL vs `prompt_retry`
- Qwen: PCL clearly better (+8.7 pp, unanimous across seeds)
- Llama: roughly tied (−0.7 pp, swings ±6 pp across seeds)

The two models behave fundamentally differently on this benchmark:

- **Qwen2.5-1.5B's direct mode is weaker (41.3%)** — the model produces non-compliant first-shot answers often. PCL's deterministic patches and structured repair give clean structural wins.
- **Llama-3.2-1B's direct mode is stronger (47.3%)** — the model is better at following IFEval-style instructions out of the box. When it does fail, `prompt_retry` (which re-prompts from scratch) often succeeds because the model can do better with a hint than it can do via an LLM rewrite of its previous attempt.

## Variance — the under-reported finding

`full_pcl` is dramatically more **stable** across seeds than the alternatives:

| | direct stddev | prompt_retry stddev | full_pcl stddev |
|---|---|---|---|
| Qwen  | ± 3.1 | ± 2.0 | **± 1.2** |
| Llama | ± 4.6 | ± 5.8 | **± 1.2** |

On Llama, `prompt_retry`'s stddev is **almost 5×** that of `full_pcl`. The +12 pp Llama prompt_retry win on seed=42 is partly **lucky sampling**, not a model-level property.

### Per-sample stability

How often does the same (sample, mode) flip between pass and fail across the 3 seeds?

| | direct flip rate | prompt_retry flip rate | full_pcl flip rate |
|---|---|---|---|
| Qwen  | 16.0% | 10.0% | **12.0%** |
| Llama | 20.0% | 14.0% | **26.0%** |

Llama is more chaotic overall, and on Llama PCL's per-sample stability degrades. The explanation: PCL's `regenerate_region` strategy adds an LLM call that itself introduces stochastic variation. When the base model is already pretty good (Llama direct = 47.3%), the extra LLM call has more chances to NOT improve things.

This is the most important takeaway for the design:

> **PCL helps most when the base model is weak at the constraint domain. On strong models, the deterministic strategies (patch, insert_section) still win — but the LLM-driven `regenerate_region` strategy adds noise that can offset its gains.**

## Loss analysis — where Llama PCL loses

Across 3 seeds × 50 samples = 150 pairs:
- `full_pcl` wins 11 cases prompt_retry loses
- `prompt_retry` wins 12 cases full_pcl loses

There are only **2 distinct samples** where prompt_retry always wins and PCL always loses across all 3 seeds:

- `ifeval.301`: `keywords:forbidden_words` (model includes a forbidden word; LLM rewrite via regenerate_region keeps including it)
- `ifeval.1147`: `keywords:forbidden_words` (same pattern)

**`keywords:forbidden_words` is a clear Phase-1 backlog item**: a deterministic strategy that strips the forbidden words (the verifier already knows where they are — `wordBoundaryRegex` finds the offset). This would be a small extension of `PatchStrategy` and should clean up both models.

The remaining 10/12 prompt_retry-only wins are scattered across instruction classes, suggesting PCL's `regenerate_region` prompt template could be further tuned. With N=3 these individual flips are within seed noise.

## Latency & cost

PCL remains substantially cheaper on both models:

| | Qwen full_pcl | Llama full_pcl |
|---|---|---|
| avg total tokens   | 647 ± 34   | 747 ± 16 |
| vs prompt_retry    | **−13%**   | **−4%**  |
| avg latency (ms)   | 2246 ± 125 | 2178 ± 41 |
| vs prompt_retry    | **−42%**   | **−34%** |

The latency win is bigger than the token win because patch/insert_section strategies are deterministic (≈1 ms). On Llama the token-cost win shrinks because prompt_retry's retry rate drops (avg_repair_rounds 0.50 vs 1.34 for PCL).

## Open questions for Phase 1.5

1. **Forbidden-words deterministic strategy** — clear Phase-1.5 backlog item from the loss analysis.
2. **regenerate_region prompt tuning** — when is it doing more harm than good? Possibly: detect when the LLM call increases violation count, treat that as an extreme regression and rollback aggressively (rollback already detects this; could be made more aggressive).
3. **Stronger base models** — Qwen3-14B or Llama-3.1-8B will tell us which trend wins: does PCL's edge close (because better models need less help) or widen (because better models can use the structured prompt more effectively)?

## Provenance

- Sweep CLI: `bun packages/compliance/benchmarks/ifeval/run.ts --limit=50 --seed={42|43|44} --model={qwen2.5-1.5b|llama-3.2-1b}`
- Aggregator: `bun packages/compliance/benchmarks/ifeval/compare-seeds.ts <dirs...>`
- 6 sweeps × ~6 min wall-clock = ~36 min total
- Tests: 113 pass / 0 fail
- Models:
  - `qwen2.5-1.5b-instruct-q4_k_m.gguf` (1.05 GB, Q4_K_M)
  - `Llama-3.2-1B-Instruct-Q4_K_M.gguf` (770 MB, Q4_K_M)
- Hardware: macOS arm64 CPU
