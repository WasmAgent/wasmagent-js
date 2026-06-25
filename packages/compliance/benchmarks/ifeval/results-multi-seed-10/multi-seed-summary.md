# IFEval Multi-Seed Sweep — Aggregate

- Seeds: 11
- Per-seed source directories:
  - `results` (150 records)
  - `results-seed43` (150 records)
  - `results-seed44` (150 records)
  - `results-seed45` (150 records)
  - `results-seed46` (150 records)
  - `results-seed47` (150 records)
  - `results-seed48` (150 records)
  - `results-seed49` (150 records)
  - `results-seed50` (150 records)
  - `results-seed51` (150 records)
  - `results-seed52` (150 records)

## Mean ± stddev across seeds

| mode | pass_rate | avg_total_tokens | avg_latency_ms |
|---|---|---|---|
| direct | 41.3% ± 2.7 | 320 ± 9 | 3115 ± 1555 |
| prompt_retry | 47.3% ± 2.6 | 747 ± 18 | 8103 ± 4002 |
| full_pcl | 53.8% ± 2.3 | 654 ± 29 | 4703 ± 2318 |

> Stddev uses n-1 (Bessel) — interpret as sample stddev across seeds. With only 3 seeds the stddev is a coarse estimate, but it sets a floor on how big a real effect must be to be credible.

## Per-seed pass rates

| mode | results | results-seed43 | results-seed44 | results-seed45 | results-seed46 | results-seed47 | results-seed48 | results-seed49 | results-seed50 | results-seed51 | results-seed52 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| direct | 44.0% (22/50) | 42.0% (21/50) | 38.0% (19/50) | 42.0% (21/50) | 44.0% (22/50) | 36.0% (18/50) | 42.0% (21/50) | 44.0% (22/50) | 42.0% (21/50) | 38.0% (19/50) | 42.0% (21/50) |
| prompt_retry | 48.0% (24/50) | 44.0% (22/50) | 46.0% (23/50) | 48.0% (24/50) | 44.0% (22/50) | 48.0% (24/50) | 50.0% (25/50) | 48.0% (24/50) | 48.0% (24/50) | 44.0% (22/50) | 52.0% (26/50) |
| full_pcl | 54.0% (27/50) | 56.0% (28/50) | 54.0% (27/50) | 54.0% (27/50) | 54.0% (27/50) | 54.0% (27/50) | 56.0% (28/50) | 56.0% (28/50) | 52.0% (26/50) | 48.0% (24/50) | 54.0% (27/50) |

## Pairwise agreement (across all seed-sample pairs)

### full_pcl vs prompt_retry

| | passed | failed |
|---|---|---|
| **full_pcl passed** | both: 236 | full_pcl-only: 60 |
| **full_pcl failed** | prompt_retry-only: 24 | neither: 230 |

Net: full_pcl wins 60, prompt_retry wins 24, net Δ = **+36** (+6.5 pp of 550 pairs).

### full_pcl vs direct

| | passed | failed |
|---|---|---|
| **full_pcl passed** | both: 227 | full_pcl-only: 69 |
| **full_pcl failed** | direct-only: 0 | neither: 254 |

Net: full_pcl wins 69, direct wins 0, net Δ = **+69** (+12.5 pp of 550 pairs).

## How to read this

- A `+6 pp ± 2 pp` mean Δ pass-rate across N seeds is more credible than the same `+6 pp` from a single seeded run.
- Pairwise agreement (rightmost block) groups *every* (seed, sample) pair and counts the four cases. A consistent winner has high `a_only` and low `b_only` across all seeds.
- With only 3 seeds the stddev estimate is rough; a real Phase-1 experiment will rerun with 5-10 seeds before reporting in a paper.
