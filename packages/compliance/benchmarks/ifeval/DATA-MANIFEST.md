# IFEval Benchmark Data — Source Manifest

1050 ComplianceEvalRecord JSONL files produced by `packages/compliance/benchmarks/ifeval/run.ts`.

## Directory layout

```
packages/compliance/benchmarks/ifeval/
├── results/                        150 records  Qwen2.5-1.5B  seed=42
├── results-seed43/                 150 records  Qwen2.5-1.5B  seed=43
├── results-seed44/                 150 records  Qwen2.5-1.5B  seed=44
├── results-llama-3.2-1b-seed42/    150 records  Llama-3.2-1B  seed=42
├── results-llama-3.2-1b-seed43/    150 records  Llama-3.2-1B  seed=43
└── results-llama-3.2-1b-seed44/    150 records  Llama-3.2-1B  seed=44
```

Each `runs.jsonl` has 150 lines: 50 × `direct` + 50 × `prompt_retry` + 50 × `full_pcl`.

## Schema

Every record is a `ComplianceEvalRecord` matching:
`evomerge-framework/schemas/compliance-eval-record.schema.json`

Key results (Phase 0 + Phase 1 P0 + multi-seed × 2 models, 2026-06-24):

| mode | Qwen2.5-1.5B mean pass% | Llama-3.2-1B mean pass% |
|---|---|---|
| direct | 41.3% ± 3.1 | 47.3% ± 4.6 |
| prompt_retry | 46.0% ± 2.0 | 59.3% ± 5.8 |
| full_pcl | 54.7% ± 1.2 | 58.7% ± 1.2 |

- PCL Δ over prompt_retry: **+8.7pp ± 2.5** on Qwen (unanimous win across 3 seeds); **−0.7pp ± 6.4** on Llama (essentially tied, but PCL has 5× smaller variance).
- PCL Δ over direct: **+13.3pp** (Qwen) / **+11.3pp** (Llama). Strictly dominant: 0 losses across 300 (seed × sample) pairs on either model.
- Full cross-model analysis: `results-multi-seed-llama/CROSS-MODEL-2026-06-24.md`.

## Import into evomerge-framework

```bash
python scripts/import_ifeval_runs.py \
  --runs-dir /path/to/wasmagent-js/packages/compliance/benchmarks/ifeval \
  --out-dir data/training/ifeval
```

Produces 657 training records (556 SFT + 67 repair-DPO + 34 cross-mode DPO).
