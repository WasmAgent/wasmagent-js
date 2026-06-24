# IFEval Multi-Seed Sweep — Aggregate

- Seeds: 3
- Per-seed source directories:
  - `results` (150 records)
  - `results-seed43` (150 records)
  - `results-seed44` (150 records)

## Mean ± stddev across seeds

| mode | pass_rate | avg_total_tokens | avg_latency_ms |
|---|---|---|---|
| direct | 41.3% ± 3.1 | 314 ± 11 | 1475 ± 45 |
| prompt_retry | 46.0% ± 2.0 | 747 ± 13 | 3864 ± 46 |
| full_pcl | 54.7% ± 1.2 | 647 ± 34 | 2246 ± 125 |

> Stddev uses n-1 (Bessel) — interpret as sample stddev across seeds. With only 3 seeds the stddev is a coarse estimate, but it sets a floor on how big a real effect must be to be credible.

## Per-seed pass rates

| mode | results | results-seed43 | results-seed44 |
|---|---|---|---|
| direct | 44.0% (22/50) | 42.0% (21/50) | 38.0% (19/50) |
| prompt_retry | 48.0% (24/50) | 44.0% (22/50) | 46.0% (23/50) |
| full_pcl | 54.0% (27/50) | 56.0% (28/50) | 54.0% (27/50) |

## Pairwise agreement (across all seed-sample pairs)

### full_pcl vs prompt_retry

| | passed | failed |
|---|---|---|
| **full_pcl passed** | both: 65 | full_pcl-only: 17 |
| **full_pcl failed** | prompt_retry-only: 4 | neither: 64 |

Net: full_pcl wins 17, prompt_retry wins 4, net Δ = **+13** (+8.7 pp of 150 pairs).

### full_pcl vs direct

| | passed | failed |
|---|---|---|
| **full_pcl passed** | both: 62 | full_pcl-only: 20 |
| **full_pcl failed** | direct-only: 0 | neither: 68 |

Net: full_pcl wins 20, direct wins 0, net Δ = **+20** (+13.3 pp of 150 pairs).

## How to read this

- A `+6 pp ± 2 pp` mean Δ pass-rate across N seeds is more credible than the same `+6 pp` from a single seeded run.
- Pairwise agreement (rightmost block) groups *every* (seed, sample) pair and counts the four cases. A consistent winner has high `a_only` and low `b_only` across all seeds.
- With only 3 seeds the stddev estimate is rough; a real Phase-1 experiment will rerun with 5-10 seeds before reporting in a paper.
