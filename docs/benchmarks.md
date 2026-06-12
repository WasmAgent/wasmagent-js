# Benchmarks

> Every number on this page is reproduced in CI on every push. Drift outside ±10 % fails the build — see [`.github/workflows/ci.yml`](https://github.com/telleroutlook/agentkit-js/blob/main/.github/workflows/ci.yml).

Run them yourself:

```bash
git clone https://github.com/telleroutlook/agentkit-js
cd agentkit-js
bun install
bun run bench           # all benchmarks
bun run bench -- ptc    # one specific suite
```

## Verified savings

| Capability | Measured | Target | Script |
|---|---|---|---|
| **Programmatic Tool Calling** vs round-trip per call | **5.1 %** of baseline tokens (–94.9 %) | ≤63 % (≥–37 %) | [`ptc-tokens.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/ptc-tokens.mjs) |
| **Tool deferred loading** (lazy MCP discovery) | **10.0 %** of baseline tokens (–90 %) | ≤15 % (≥–85 %) | [`defer-loading.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/defer-loading.mjs) |
| **`inputExamples` accuracy uplift** | 76 % → **92 %** | 72 → 90 | [`input-examples.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/input-examples.mjs) |
| **Context editing** (cache-stable history compaction) | **13.8 %** of baseline tokens (–86 %) | ≤16 % (≥–84 %) | [`context-editing.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/context-editing.mjs) |
| **Observational memory** (compressed reflection prefix) | **21.9 %** of baseline (–78 %) | ~22 % (≤25 %) | [`observational-memory.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/observational-memory.mjs) |
| **Code-mode bootstrap** (N=30 tools, vs direct MCP) | **13.6 %** of baseline tokens (–86 %) | ≤50 % (codemode-lite reported 53 %) | [`code-mode-tokens.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/code-mode-tokens.mjs) |
| **`ParallelForkJoinRunner`** (8 branches, cap=4) | ~**3.8×** wall-clock vs equivalent serial work; tokens scale linearly | ≥2.5× speedup, 4–12× tokens | [`parallel-agents.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/parallel-agents.mjs) |
| **Cross-model cost comparison** (same task, 11 models) | DeepSeek V4 cheapest at **~$0.003** ; Claude Opus most expensive at **~$0.15** (≈56× ratio) | cheapest <$0.05, most-expensive <$5, ratio in 5×–200× range | [`cost-comparison.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/cost-comparison.mjs) → [report](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/report-cost-comparison.md) |

## LongMemEval-style end-to-end (real local model, 2026-06-12)

The accounting benchmarks above demonstrate **mechanism**. This row is an
end-to-end check against a real local LLM: does
[`ObservationalMemory`](../packages/core/src/memory/) compress history
*without* dropping accuracy when a real model has to read the result?

Run yourself:

```bash
node examples/benchmarks/longmemeval.mjs --full \
  --model=evomerge-qwen3-v2:latest \
  --base-url=http://localhost:11434/v1 \
  --temperature=0
```

Reproduced 2026-06-12 against `evomerge-qwen3-v2:latest`
(Qwen3 8B, 40K ctx, an [evomerge](https://github.com/telleroutlook/evomerge)
chat-vec merge available locally via Ollama at temperature=0):

| Mode | Accuracy | Total tokens | Where the savings come from |
|---|---:|---:|---|
| Baseline (full history) | **5/6 = 83.3 %** | 2 207 | — |
| ObservationalMemory (compressed prefix) | **5/6 = 83.3 %** | 1 708 (–22.6 %) | Long-history item S6: 654→202 input tokens (–69 %), same answer |

Short conversations (4-turn fixtures S1–S5) are below
ObservationalMemory's compression threshold — the trailing window covers
them — so the two columns are identical there. The real signal is S6:
when a long noisy history needs to fit in a smaller context, the
compressed observation preserves the answer-bearing facts at one-third
the input tokens with **no quality regression**.

**Caveats**

- The bundled 6-item set is a sanity floor, not a leaderboard score.
  Mastra's published 94.87 % was on the official 500-question
  [LongMemEval](https://github.com/xiaowu0162/LongMemEval) test set; a
  full-suite run lives in `examples/eval-suite/longmemeval-runner.mjs`
  (planned 2026-Q3, requires API budget).
- The `--full` mode is **not** in CI — it requires a running model
  endpoint. The CI gate is `--sample` mode (default), which uses a
  heuristic answerer and pins compression mechanics rather than model
  accuracy. See the script header for the exact methodology.
- Temporal-reasoning category (S4: "started Jan 5 2025, today is Jan 5
  2026 → 1 year") fails on this 8B model in BOTH modes; that's a model
  observation, not an ObservationalMemory observation.

## Why these are not marketing numbers

- **Mechanism-focused, not credentials-required.** Each benchmark uses a deterministic fake model that returns scripted trajectories. We're measuring *whether the mechanism strips schemas / compacts history / etc.*, not re-asking a real LLM the same question.
- **CI-gated.** A regression that pushes a number out of tolerance fails the build, so the README cannot quietly bit-rot.
- **Reproducible.** No hidden flags, no special environment — `bun run bench` is the entire pipeline.

The same approach extends to upcoming numbers: parallel-runner wall-clock (Wave 4), cross-model cost comparison (Wave 5 / H), kernel cold-start.

## Read the source

The runner is a single file — [`examples/benchmarks/run-all.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/run-all.mjs) — that imports each suite, invokes it, and exits non-zero on tolerance breach.
