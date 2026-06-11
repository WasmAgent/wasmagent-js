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
| **`ParallelForkJoinRunner`** (8 branches, cap=4) | ~**3.8×** wall-clock vs equivalent serial work; tokens scale linearly | ≥2.5× speedup, 4–12× tokens | [`parallel-agents.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/parallel-agents.mjs) |

## Why these are not marketing numbers

- **Mechanism-focused, not credentials-required.** Each benchmark uses a deterministic fake model that returns scripted trajectories. We're measuring *whether the mechanism strips schemas / compacts history / etc.*, not re-asking a real LLM the same question.
- **CI-gated.** A regression that pushes a number out of tolerance fails the build, so the README cannot quietly bit-rot.
- **Reproducible.** No hidden flags, no special environment — `bun run bench` is the entire pipeline.

The same approach extends to upcoming numbers: parallel-runner wall-clock (Wave 4), cross-model cost comparison (Wave 5 / H), kernel cold-start.

## Read the source

The runner is a single file — [`examples/benchmarks/run-all.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/run-all.mjs) — that imports each suite, invokes it, and exits non-zero on tolerance breach.
