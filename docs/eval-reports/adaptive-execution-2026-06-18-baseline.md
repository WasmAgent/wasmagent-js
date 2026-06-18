# Adaptive execution — paired-stat ablation

Date: 2026-06-18 · n = 30 per arm · mock-LLM (deterministic)

Methodology: each layer has two arms — feature on vs off — and
we run N identical fixtures under each. Pass = agent reached the
intended outcome (used the alternative tool / synthesised / 
verified after negotiation). McNemar exact on (b, c) discordant
pairs; null = layer has no effect on outcome.

| Layer | Arm A (off) pass | Arm B (on) pass | Δpp | b (off→on flips) | c (on→off flips) | McNemar p |
|-------|:----------------:|:---------------:|:---:|:----------------:|:----------------:|:---------:|
| **L1 — Tool fallback** | 0.0% | 100.0% | 100.0 | 30 | 0 | 1.86e-9 |
| **L2 — Tool synthesis** | 0.0% | 100.0% | 100.0 | 30 | 0 | 1.86e-9 |
| **L3 — Goal adaptation** | 0.0% | 100.0% | 100.0 | 30 | 0 | 1.86e-9 |

## Interpretation

- **b** column = items where the off arm failed and the on arm passed (the layer rescued the run).
- **c** column = items where the on arm regressed compared to off (would be a red flag if non-zero).
- A small p-value rejects the null "the layer has no effect". With deterministic mocks we expect
  near-binary outcomes — every layer should be either p ≪ 0.05 (mechanism works) or p = 1 (mock
  insensitive). Real-LLM follow-up will produce intermediate values.

## Caveats

- This is a **mechanism-level** ablation: the mock model is calibrated to take prompt-level hints
  the same way a small real model does, but the magnitude does not transfer 1:1. A real-LLM run
  is the appropriate next step — see the open question in `docs/rfcs/adaptive-execution.md`.
- Each layer's mock is independent of the others. L1+L2+L3 cross-interactions are not measured
  here; the strategy doc §1 argues they compose, but a follow-up suite should verify it.

Source: `examples/benchmarks/adaptive-execution-ablation.mjs`. Re-run with `bun run` from repo root.
