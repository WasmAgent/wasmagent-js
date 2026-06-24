# @wasmagent/compliance

> ⚠️ **Status: experimental (`0.1.0-alpha`).** APIs may change without notice.

A lightweight compliance engine for validating, repairing, and exporting evidence from LLM
agent runs.

`@wasmagent/compliance` lets you define **TaskSpecs**, validate model outputs and tool calls
against typed **ConstraintIR**, repair violations locally (instead of full retry), and export
trace records for evaluation and training data.

## What it is

- **TaskSpec → ConstraintIR → Verifier → RepairTrace → EvalRecord.** A 5-step contract for
  turning a natural-language task into a verifiable program.
- **Built on `@wasmagent/core` Verifier.** `ConstraintIR extends Criterion`. Anything that
  works with `VerificationPipeline` works here, plus violations carry an `evidence_span` for
  local repair targeting.
- **Local repair, not full retry.** A `RepairPlanner` picks the cheapest patch that resolves
  each violation: token-span patch, field repair, section repair, region regeneration, full
  regenerate (last resort).

## What it is not

- Not a new agent framework. It does **not** replace LangGraph, AutoGen, or Microsoft Agent
  Framework. It is the verification and repair layer used *inside* an agent run.
- Not a new constrained-decoding engine. It composes with XGrammar / Outlines / llguidance,
  it does not replace them.
- Not a generic Guardrails or extraction SDK (Instructor, PydanticAI, Guardrails AI). Those
  optimize for input-output guard rails on a single LLM call; this optimizes for **agent run
  compliance evidence** — proof that a multi-step run satisfied its TaskSpec, with traceable
  violations and repairs.

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

### Headline results (mean ± stddev across 3 seeds, 50 samples each)

| mode | Qwen2.5-1.5B | Llama-3.2-1B |
|---|---|---|
| direct       | 41.3% ± 3.1 | 47.3% ± 4.6 |
| prompt_retry | 46.0% ± 2.0 | 59.3% ± 5.8 |
| **full_pcl** | **54.7% ± 1.2** | **58.7% ± 1.2** |

Δ vs prompt_retry: **+8.7 pp (Qwen)** · **−0.7 pp (Llama)** — the PCL win
is model-dependent. Δ vs direct: **+11 to +13 pp on both models** —
the repair layer is monotonic.

`full_pcl` is also the **most stable** mode across seeds (stddev 1.2)
— on Llama prompt_retry's stddev is 5× larger.

Full reports: `benchmarks/ifeval/results-multi-seed-llama/CROSS-MODEL-2026-06-24.md`.

### What's wired

- [x] `TaskSpec` / `ConstraintIR` types (extends `@wasmagent/core` `Criterion`)
- [x] JSON schemas for TaskSpec / ConstraintIR / Violation / RepairTrace / EvalRecord
- [x] `ConstraintViolation` with `evidence_span` (Zod-validated to always carry ≥1 locator)
- [x] `ComplianceVerifier` wrapper around `VerificationPipeline`
- [x] `IFEvalVerifier` covering 15 of IFEval's 25 instruction classes
- [x] 50-sample curated IFEval subset (deterministic, sha256-pinned)
- [x] `RepairPlanner` with escalation + rollback-on-regression
- [x] Three repair strategies: `patch` · `insert_section` · `regenerate_region`
- [x] `ComplianceRun` orchestrator for `direct` / `prompt_retry` / `full_pcl` modes
- [x] Multi-seed benchmark CLI with file-lock guard + structured `error` records
- [x] Multi-seed aggregator (mean ± stddev, pairwise agreement)
- [x] 113 tests, 0 failures

### Phase 1 backlog

- [ ] Larger base models (Llama-3.1-8B-Instruct, Qwen3-14B)
- [ ] Additional benchmarks (ComplexBench, CFBench, IHEval, JSONSchemaBench)
- [x] Align `ComplianceEvalRecord` with evomerge-framework pipeline — 1050 records
      imported via `scripts/import_ifeval_runs.py`, 657 training records exported
      (556 SFT + 67 repair-DPO + 34 cross-mode DPO). See
      [evomerge-framework](https://github.com/telleroutlook/evomerge-framework) and
      `benchmarks/ifeval/DATA-MANIFEST.md`.
- [ ] `forbidden_words` deterministic patch strategy (Phase 1 backlog from cross-model loss analysis)
- [ ] N=10 seeds with bootstrap CI for paper-grade significance

## Training data loop

The 1050 `ComplianceEvalRecord` files in `benchmarks/ifeval/results*/runs.jsonl`
feed directly into the evomerge-framework training pipeline:

```bash
# import into evomerge-framework (run from evomerge-framework repo)
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
