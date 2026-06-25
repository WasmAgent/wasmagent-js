# IFEval Multi-Seed Sweep — Aggregate

- Seeds: 10
- Per-seed source directories:
  - `results-llama-3.2-1b-seed42` (150 records)
  - `results-llama-3.2-1b-seed43` (150 records)
  - `results-llama-3.2-1b-seed44` (150 records)
  - `results-llama-3.2-1b-seed45` (150 records)
  - `results-llama-3.2-1b-seed46` (150 records)
  - `results-llama-3.2-1b-seed47` (150 records)
  - `results-llama-3.2-1b-seed48` (150 records)
  - `results-llama-3.2-1b-seed49` (150 records)
  - `results-llama-3.2-1b-seed50` (150 records)
  - `results-llama-3.2-1b-seed51` (150 records)

## Mean ± stddev across seeds

| mode | pass_rate | avg_total_tokens | avg_latency_ms |
|---|---|---|---|
| direct | 46.4% ± 3.0 | 380 ± 14 | 1486 ± 66 |
| prompt_retry | 57.4% ± 4.0 | 797 ± 36 | 3367 ± 131 |
| full_pcl | 58.2% ± 2.7 | 729 ± 47 | 2101 ± 123 |

> Stddev uses n-1 (Bessel) — interpret as sample stddev across seeds. With only 3 seeds the stddev is a coarse estimate, but it sets a floor on how big a real effect must be to be credible.

## Per-seed pass rates

| mode | results-llama-3.2-1b-seed42 | results-llama-3.2-1b-seed43 | results-llama-3.2-1b-seed44 | results-llama-3.2-1b-seed45 | results-llama-3.2-1b-seed46 | results-llama-3.2-1b-seed47 | results-llama-3.2-1b-seed48 | results-llama-3.2-1b-seed49 | results-llama-3.2-1b-seed50 | results-llama-3.2-1b-seed51 |
|---|---|---|---|---|---|---|---|---|---|---|
| direct | 50.0% (25/50) | 42.0% (21/50) | 50.0% (25/50) | 46.0% (23/50) | 48.0% (24/50) | 44.0% (22/50) | 48.0% (24/50) | 42.0% (21/50) | 46.0% (23/50) | 48.0% (24/50) |
| prompt_retry | 66.0% (33/50) | 56.0% (28/50) | 56.0% (28/50) | 52.0% (26/50) | 58.0% (29/50) | 62.0% (31/50) | 58.0% (29/50) | 56.0% (28/50) | 54.0% (27/50) | 56.0% (28/50) |
| full_pcl | 58.0% (29/50) | 58.0% (29/50) | 60.0% (30/50) | 60.0% (30/50) | 58.0% (29/50) | 54.0% (27/50) | 58.0% (29/50) | 56.0% (28/50) | 56.0% (28/50) | 64.0% (32/50) |

## Pairwise agreement (across all seed-sample pairs)

### full_pcl vs prompt_retry

| | passed | failed |
|---|---|---|
| **full_pcl passed** | both: 252 | full_pcl-only: 39 |
| **full_pcl failed** | prompt_retry-only: 35 | neither: 174 |

Net: full_pcl wins 39, prompt_retry wins 35, net Δ = **+4** (+0.8 pp of 500 pairs).

### full_pcl vs direct

| | passed | failed |
|---|---|---|
| **full_pcl passed** | both: 232 | full_pcl-only: 59 |
| **full_pcl failed** | direct-only: 0 | neither: 209 |

Net: full_pcl wins 59, direct wins 0, net Δ = **+59** (+11.8 pp of 500 pairs).

## How to read this

- A `+6 pp ± 2 pp` mean Δ pass-rate across N seeds is more credible than the same `+6 pp` from a single seeded run.
- Pairwise agreement (rightmost block) groups *every* (seed, sample) pair and counts the four cases. A consistent winner has high `a_only` and low `b_only` across all seeds.
- With only 3 seeds the stddev estimate is rough; a real Phase-1 experiment will rerun with 5-10 seeds before reporting in a paper.
