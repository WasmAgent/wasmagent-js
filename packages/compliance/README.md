# @wasmagent/compliance

> ⚠️ **Status: experimental (`0.1.0-alpha`).** APIs may change without notice.
>
> This package is the **runtime compliance source of truth** for the WasmAgent ecosystem.
> See the [ecosystem map](https://github.com/WasmAgent/trace-pipeline/blob/main/docs/ecosystem-map.md) for how it fits into the Trustworthy Agent Training Loop.

A lightweight compliance engine for validating, repairing, and exporting evidence from LLM
agent runs.

`@wasmagent/compliance` lets you define **TaskSpecs**, validate model outputs and tool calls
against typed **ConstraintIR**, repair violations locally using **Protocol-Constrained Local
Repair (PCL)** — instead of full retry — and export trace records for evaluation and training data.

## Core concepts

- **TaskSpec → ConstraintIR → Verifier → RepairTrace → EvalRecord.** A 5-step contract for
  turning a natural-language task into a verifiable program.
- **Built on `@wasmagent/core` Verifier.** `ConstraintIR extends Criterion`. Anything that
  works with `VerificationPipeline` works here, plus violations carry an `evidence_span` for
  local repair targeting.
- **Protocol-Constrained Local Repair (PCL), not full retry.** The `RepairPlanner` picks the
  cheapest patch that resolves each violation: token-span patch, field repair, section repair,
  region regeneration, or full regenerate (last resort). `full_pcl` is the execution mode
  that invokes PCL; `prompt_retry` simply re-prompts with violation hints appended.

## Execution modes

| Mode | Description |
|---|---|
| `direct` | Single-pass generation, no repair |
| `prompt_retry` | On failure, regenerate up to N times with violation hints appended |
| `full_pcl` | **Protocol-Constrained Local Repair** — targeted, constraint-by-constraint repair |

## Quick start

```ts
import { ComplianceRun, type TaskSpec } from "@wasmagent/compliance";

const spec: TaskSpec = {
  id: "markdown-report.v1",
  intent: "produce_research_summary",
  language: "en",
  constraints: [
    {
      id: "c1",
      description: "Output must contain a Conclusion heading",
      verify_method: "file_contains",
      arg: "# Conclusion",
      path: "out.md",
      level: "hard",
      priority: 100,
      category: "format",
      repair: { strategy: "insert_section", target_region: "Conclusion" },
    },
  ],
  priority_hierarchy: ["system_policy", "user_explicit_constraints"],
};

const run = new ComplianceRun({ spec, /* model, workspace, repairPlanner */ });
const record = await run.execute();
console.log(record.final_pass, record.violations, record.repair_rounds);
```

## Phase status

**Phase 0 + Phase 1 P0 complete (2026-06-24).** Multi-seed, two-model
empirical validation on IFEval.

### Observed results (mean ± stddev across 3 seeds × 50 samples)

| mode | Qwen2.5-1.5B | Llama-3.2-1B |
|---|---|---|
| `direct` | 41.3% ± 3.1 | 47.3% ± 4.6 |
| `prompt_retry` | 46.0% ± 2.0 | 59.3% ± 5.8 |
| **`full_pcl`** (Protocol-Constrained Local Repair) | **54.7% ± 1.2** | **58.7% ± 1.2** |

Key findings:
- PCL Δ vs `prompt_retry`: **+8.7 pp (Qwen)** · **−0.7 pp (Llama)** — win is model-dependent
- PCL Δ vs `direct`: **+13 pp (Qwen)** / **+11 pp (Llama)** — repair layer is strictly monotonic (0 regressions)
- `full_pcl` is the **most stable** mode (stddev 1.2 vs prompt_retry 2.0–5.8)

Full reports: `benchmarks/ifeval/results-multi-seed-llama/CROSS-MODEL-2026-06-24.md`.

### Roadmap (not yet observed)

- [ ] N=10 seeds with bootstrap CI for paper-grade significance
- [ ] Larger base models (Llama-3.1-8B-Instruct, Qwen3-14B)
- [ ] Additional benchmarks (ComplexBench, CFBench, IHEval, JSONSchemaBench)
- [ ] `forbidden_words` deterministic patch strategy
- [ ] Group A vs C comparison (fine-tuned small model via trace-pipeline)

### What's implemented

- [x] `TaskSpec` / `ConstraintIR` types (extends `@wasmagent/core` `Criterion`)
- [x] Versioned JSON schemas (`schema_version: "compliance-eval-record/v1"`)
- [x] `ConstraintViolation` with `evidence_span` (carries ≥1 location pointer)
- [x] `ComplianceVerifier` wrapper around `VerificationPipeline`
- [x] `IFEvalVerifier` covering 15 of IFEval's 25 instruction classes
- [x] 50-sample curated IFEval subset (deterministic, sha256-pinned)
- [x] `RepairPlanner` with escalation + rollback-on-regression
- [x] Three repair strategies: `patch` · `insert_section` · `regenerate_region`
- [x] `ComplianceRun` orchestrator for `direct` / `prompt_retry` / `full_pcl` modes
- [x] Multi-seed benchmark CLI with file-lock guard + structured `error` records
- [x] Multi-seed aggregator (mean ± stddev, pairwise agreement)
- [x] 113 tests, 0 failures
- [x] 1050 `ComplianceEvalRecord` instances → 657 trace-pipeline training records

The 1050 `ComplianceEvalRecord` files in `benchmarks/ifeval/results*/runs.jsonl`
feed directly into the trace-pipeline training pipeline:

```bash
# import into trace-pipeline (run from trace-pipeline repo)
python scripts/import_ifeval_runs.py \
  --runs-dir /path/to/wasmagent-js/packages/compliance/benchmarks/ifeval \
  --out-dir data/training/ifeval

# train router classifier
python scripts/train_router.py \
  --runs-dir /path/to/wasmagent-js/packages/compliance/benchmarks/ifeval \
  --out-dir data/router

# QLoRA SFT
python scripts/train_sft.py \
  --train-data data/training/ifeval/compliance_sft.jsonl \
  --base-model <local-model-path> \
  --out-dir checkpoints/sft-v1
```

Router GBDT (trained on 300 real samples): CV accuracy **92.7% ± 2.5%**.
Top features: `n_hard_violations` (38.5%), `n_violations` (30.8%), `prompt_tokens` (14.2%).

## License

Apache-2.0
