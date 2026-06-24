# IFEval Multi-Seed Sweep — Aggregate

- Seeds: 3
- Per-seed source directories:
  - `results-llama-3.2-1b-seed42` (150 records)
  - `results-llama-3.2-1b-seed43` (150 records)
  - `results-llama-3.2-1b-seed44` (150 records)

## Mean ± stddev across seeds

| mode | pass_rate | avg_total_tokens | avg_latency_ms |
|---|---|---|---|
| direct | 47.3% ± 4.6 | 395 ± 10 | 1553 ± 55 |
| prompt_retry | 59.3% ± 5.8 | 774 ± 20 | 3303 ± 95 |
| full_pcl | 58.7% ± 1.2 | 747 ± 16 | 2178 ± 41 |

> Stddev uses n-1 (Bessel) — interpret as sample stddev across seeds. With only 3 seeds the stddev is a coarse estimate, but it sets a floor on how big a real effect must be to be credible.

## Per-seed pass rates

| mode | results-llama-3.2-1b-seed42 | results-llama-3.2-1b-seed43 | results-llama-3.2-1b-seed44 |
|---|---|---|---|
| direct | 50.0% (25/50) | 42.0% (21/50) | 50.0% (25/50) |
| prompt_retry | 66.0% (33/50) | 56.0% (28/50) | 56.0% (28/50) |
| full_pcl | 58.0% (29/50) | 58.0% (29/50) | 60.0% (30/50) |

## Pairwise agreement (across all seed-sample pairs)

### full_pcl vs prompt_retry

| | passed | failed |
|---|---|---|
| **full_pcl passed** | both: 77 | full_pcl-only: 11 |
| **full_pcl failed** | prompt_retry-only: 12 | neither: 50 |

Net: full_pcl wins 11, prompt_retry wins 12, net Δ = **-1** (-0.7 pp of 150 pairs).

### full_pcl vs direct

| | passed | failed |
|---|---|---|
| **full_pcl passed** | both: 71 | full_pcl-only: 17 |
| **full_pcl failed** | direct-only: 0 | neither: 62 |

Net: full_pcl wins 17, direct wins 0, net Δ = **+17** (+11.3 pp of 150 pairs).

## How to read this

- A `+6 pp ± 2 pp` mean Δ pass-rate across N seeds is more credible than the same `+6 pp` from a single seeded run.
- Pairwise agreement (rightmost block) groups *every* (seed, sample) pair and counts the four cases. A consistent winner has high `a_only` and low `b_only` across all seeds.
- With only 3 seeds the stddev estimate is rough; a real Phase-1 experiment will rerun with 5-10 seeds before reporting in a paper.
