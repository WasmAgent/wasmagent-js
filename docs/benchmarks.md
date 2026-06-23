# Benchmarks

> Every number on this page is reproduced in CI on every push. Drift outside ±10 % fails the build — see [`.github/workflows/ci.yml`](https://github.com/WasmAgent/wasmagent-js/blob/main/.github/workflows/ci.yml).

Run them yourself:

```bash
git clone https://github.com/WasmAgent/wasmagent-js
cd wasmagent-js
bun install
bun run bench           # all benchmarks
bun run bench -- ptc    # one specific suite
```

## Verified savings

| Capability | Measured | Target | Script |
|---|---|---|---|
| **Programmatic Tool Calling** vs round-trip per call | **5.1 %** of baseline tokens (–94.9 %) | ≤63 % (≥–37 %) | [`ptc-tokens.mjs`](https://github.com/WasmAgent/wasmagent-js/blob/main/examples/benchmarks/ptc-tokens.mjs) |
| **Tool deferred loading** (lazy MCP discovery) | **10.0 %** of baseline tokens (–90 %) | ≤15 % (≥–85 %) | [`defer-loading.mjs`](https://github.com/WasmAgent/wasmagent-js/blob/main/examples/benchmarks/defer-loading.mjs) |
| **`inputExamples` accuracy uplift** | 76 % → **92 %** | 72 → 90 | [`input-examples.mjs`](https://github.com/WasmAgent/wasmagent-js/blob/main/examples/benchmarks/input-examples.mjs) |
| **Context editing** (cache-stable history compaction) | **13.8 %** of baseline tokens (–86 %) | ≤16 % (≥–84 %) | [`context-editing.mjs`](https://github.com/WasmAgent/wasmagent-js/blob/main/examples/benchmarks/context-editing.mjs) |
| **Observational memory** (compressed reflection prefix) | **21.9 %** of baseline (–78 %) | ~22 % (≤25 %) | [`observational-memory.mjs`](https://github.com/WasmAgent/wasmagent-js/blob/main/examples/benchmarks/observational-memory.mjs) |
| **Code-mode bootstrap** (N=30 tools, vs direct MCP) | **13.6 %** of baseline tokens (–86 %) | ≤50 % (codemode-lite reported 53 %) | [`code-mode-tokens.mjs`](https://github.com/WasmAgent/wasmagent-js/blob/main/examples/benchmarks/code-mode-tokens.mjs) |
| **`ParallelForkJoinRunner`** (8 branches, cap=4) | ~**3.8×** wall-clock vs equivalent serial work; tokens scale linearly | ≥2.5× speedup, 4–12× tokens | [`parallel-agents.mjs`](https://github.com/WasmAgent/wasmagent-js/blob/main/examples/benchmarks/parallel-agents.mjs) |
| **Cross-model cost comparison** (same task, 11 models) | DeepSeek V4 cheapest at **~$0.003** ; Claude Opus most expensive at **~$0.15** (≈56× ratio) | cheapest <$0.05, most-expensive <$5, ratio in 5×–200× range | [`cost-comparison.mjs`](https://github.com/WasmAgent/wasmagent-js/blob/main/examples/benchmarks/cost-comparison.mjs) → [report](https://github.com/WasmAgent/wasmagent-js/blob/main/examples/benchmarks/report-cost-comparison.md) |

> **2026-06-17 note on the code-mode row.** The 13.6%-of-baseline number
> is still verifiable, but code-mode token savings are no longer a
> differentiator — Cloudflare ships code-mode portal-default
> (2026-03-26), OpenAI Agents SDK has a native sandbox (2026-04),
> Anthropic standardised the pattern. Treat this row as **mechanism
> verification**, not as competitive claim. The differentiator is the
> *neutral, multi-language, multi-isolation-tier kernel matrix* that
> can be dropped into any of those framework executor sockets — see
> [`docs/kernels/comparison.md`](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/kernels/comparison.md)
> and the S1 / S1' axes in [`ROADMAP.md`](https://github.com/WasmAgent/wasmagent-js/blob/main/ROADMAP.md).

## LongMemEval-style end-to-end across 5 local models (2026-06-12)

The accounting benchmarks above demonstrate **mechanism**. This section
puts ObservationalMemory in front of five real local models spanning a
**17× size range** (0.40 GB → 6.78 GB) and asks one question:

> Does the compressed prefix preserve enough signal that a model
> reaches the same conclusions as it would with the full history?

Reproduce yourself (Ollama running locally):

```bash
for m in qwen2.5:0.5b evo-qwen3-1b7-q3km:latest evomerge-qwen25-1b5:latest evomerge-qwen3-v2:latest gemma4-12b:latest; do
  node examples/benchmarks/longmemeval.mjs --full --model="$m" --temperature=0
done
```

### Results — 6-item LongMemEval-style fixture, T=0

| Model | Size | Baseline acc | Observed acc | Δ acc | Tokens (B→O) | Token ratio |
|---|---:|:-:|:-:|:-:|---:|---:|
| `qwen2.5:0.5b` | 0.40 GB | 4/6 = 67 % | 4/6 = 67 % | **0.0 pp** | 1 190 → 733 | 61.6 % |
| `evo-qwen3-1b7-q3km` (LoRA Q3_K_M) | 0.94 GB | 5/6 = 83 % | 5/6 = 83 % | **0.0 pp** | 2 066 → 1 511 | 73.1 % |
| `evomerge-qwen25-1b5` | 1.65 GB | 4/6 = 67 % | 4/6 = 67 % | **0.0 pp** | 1 205 → 753 | 62.5 % |
| `evomerge-qwen3-v2` (Qwen3 8B) | 4.12 GB | 5/6 = 83 % | 5/6 = 83 % | **0.0 pp** | 2 207 → 1 708 | 77.4 % |
| `gemma4-12b` | 6.78 GB | 5/6 = 83 % | 5/6 = 83 % | **0.0 pp** | 1 848 → 1 377 | 74.5 % |

### What this proves and what it does not

**Proves**: ObservationalMemory's compression preserves decision-relevant
signal across the full capacity range tested. **Every** model (0.5B
through 12B) gives the same answers in the compressed-prefix mode that
it gave with the full history — for every one of the 6 items. **Δ acc =
0.0 pp on all 5 models**.

**Does not prove**: that the 6-item fixture predicts performance on the
official 500-question [LongMemEval](https://github.com/xiaowu0162/LongMemEval)
suite (Mastra's public 94.87 % score). It only proves the mechanism is
not silently dropping facts at this difficulty.

### Per-item breakdown — pattern in the failures

| Item | Type | 0.5B | 0.94GB-Q3KM | 1.5B-chat-vec | 8B | 12B |
|---|---|:-:|:-:|:-:|:-:|:-:|
| S1 | breed recall | ✅ | ✅ | **❌** | ✅ | ✅ |
| S2 | birthday recall | ✅ | ✅ | ✅ | ✅ | ✅ |
| S3 | knowledge update | ✅ | ✅ | **❌** | ✅ | ✅ |
| S4 | temporal reasoning ("1 year" arithmetic) | ❌ | ❌ | **✅** | ❌ | ❌ |
| S5 | favourite number | ❌ | ✅ | ✅ | ✅ | ✅ |
| S6 | long-context colour | ✅ | ✅ | ✅ | ✅ | ✅ |

Two non-obvious findings the failure pattern reveals:

1. **The 0.94 GB Qwen3-1.7B + LoRA-v3 Q3_K_M matches the 4.12 GB and
   6.78 GB models on this benchmark**, despite [evomerge's own quality
   gate](https://github.com/telleroutlook/evomerge/blob/main/PHASE14_FINAL_REPORT.md)
   marking that quant as ❌-fail (–14.5 pp on GSM8K, –22.8 pp on MMLU
   vs fp16). **Compression-task degradation does not predict
   memory-task degradation.** A model that is 25 % worse at math word
   problems can be at parity for "what colour did the user mention 28
   turns ago".
2. **`evomerge-qwen25-1b5` (the chat-vec-merged Qwen2.5-1.5B-Coder with
   λ=0.7) is the only model that passes S4** (temporal reasoning) but
   fails S1 + S3 (basic recall) — exact opposite profile from every
   other model. Math-skill–boosting merges leave fingerprints on
   recall behaviour. For LongMemEval-style tasks this is a *worse*
   profile than the unmerged model would give; that doesn't make the
   merge bad, just task-mismatched.

### Caveats

- The bundled 6-item set is a sanity floor, not a leaderboard score.
  Mastra's public 94.87 % was on the official 500-question test set; a
  full-suite run lives in `examples/eval-suite/longmemeval-runner.mjs`
  (planned 2026-Q3, requires API budget).
- The `--full` mode is **not** in CI — it requires a running model
  endpoint. The CI gate is `--sample` mode (default).
- All five models miss S4 (the temporal-reasoning item) **except** the
  chat-vec model, with the trade-off described above. That's a small-N
  observation about local sub-12B models, not a claim about LongMemEval
  in general.
- "Tokens" includes both input (history + prompt) and output. The
  smaller models output shorter answers, which is why their token ratio
  looks more favourable than the 8B/12B ratio — the compression is the
  same magnitude in absolute input tokens (S6 went 654→200ish on every
  model) but a larger fraction of those models' total budget.

## Same fixture, run via `wasmagent evals` (2026-06-12, prompt re-tuned)

The runner shipped in `@wasmagent/evals-runner@1.0.0` uses a more
prescriptive system message ("Reply with the answer ONLY — no preamble,
no explanation. Be concise"). On the same 6-item fixture, T=0, 1 seed,
the per-model results shifted in a way that's worth recording:

```bash
wasmagent evals run --suite=multi-turn-memory \
  --models="qwen2.5:0.5b,evo-qwen3-1b7-q3km:latest,evomerge-qwen25-1b5:latest,evomerge-qwen3-v2:latest,gemma4-12b:latest" \
  --base-url=http://localhost:11434/v1 --seeds=0
```

| Model                                     | Size    | Acc        | p95 wall | Pareto |
| ----------------------------------------- | ------: | :--------: | -------: | :----: |
| `qwen2.5:0.5b`                            | 0.40 GB | 4/6 = 67%  |   1 038 ms | ★      |
| `evo-qwen3-1b7-q3km:latest`               | 0.94 GB | **6/6 = 100%** |  4 009 ms | ★ |
| `evomerge-qwen25-1b5:latest`              | 1.65 GB | 4/6 = 67%  |  1 635 ms |        |
| `evomerge-qwen3-v2:latest`                | 4.12 GB | **6/6 = 100%** | 16 492 ms |   |
| `gemma4-12b:latest`                       | 6.78 GB | **6/6 = 100%** | 16 510 ms |   |

**Two new findings vs the bash-loop run above**:

1. **Three of five models now reach 100%** (vs the previous 5/6 = 83%).
   The single-item swing was S5 ("favourite number = 17"), where the
   directive system message stops the larger models from adding "Your
   favourite number is 17, which is a prime!" prose that the substring
   matcher counted as a non-answer in the looser earlier prompt. The
   `q3km` model also benefits and now matches the 8B / 12B accuracy.
2. **The Pareto front is now `qwen2.5:0.5b` + `evo-qwen3-1b7-q3km`.**
   Both 8B and 12B are *dominated* — same accuracy at 4× higher p95
   wall. If you only need this benchmark and your 0.94 GB model already
   scores 100% in 4 s, the 12B is paying for nothing.

The lesson is on prompt sensitivity, not on memory: small accuracy
swings in this fixture are mostly attributable to instruction
phrasing, which is the same reason `wasmagent evals` reports `σ across
seeds` and Wilson CI on every cell — for any single number to be a
defensible claim, you need ≥3 seeds and the variance across them
disclosed.

The full report (markdown, exactly as `--report-file` writes it) is
preserved at `docs/reports/longmemeval-5model-2026-06-12.md`.

## Why these are not marketing numbers

- **Mechanism-focused, not credentials-required.** Each benchmark uses a deterministic fake model that returns scripted trajectories. We're measuring *whether the mechanism strips schemas / compacts history / etc.*, not re-asking a real LLM the same question.
- **CI-gated.** A regression that pushes a number out of tolerance fails the build, so the README cannot quietly bit-rot.
- **Reproducible.** No hidden flags, no special environment — `bun run bench` is the entire pipeline.

The same approach extends to upcoming numbers: parallel-runner wall-clock (Wave 4), cross-model cost comparison (Wave 5 / H), kernel cold-start.

## Read the source

The runner is a single file — [`examples/benchmarks/run-all.mjs`](https://github.com/WasmAgent/wasmagent-js/blob/main/examples/benchmarks/run-all.mjs) — that imports each suite, invokes it, and exits non-zero on tolerance breach.
