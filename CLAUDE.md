# wasmagent-js — Development Guide for Claude

## Test Commands

**IMPORTANT: This project uses `bun test` (not `npx vitest run`, not `npm test`).**

```bash
# Run all tests from repo root
bun test packages/core/src/
bun test packages/cloudflare-worker/src/   # --isolate is baked into bunfig.toml, no flag needed
bun test packages/cli/
bun test packages/model-anthropic/src/
# etc.

# DevTools (React/DOM tests) MUST be run from within the package directory:
cd packages/devtools && bun test

# Run a specific test file
bun test packages/core/src/agents/ToolCallingAgent.test.ts

# RLAIF-specific test suites
bun test packages/core/src/enhancement/RolloutForkRunner.test.ts
bun test packages/core/src/ranking/RolloutRanker.test.ts
bun test packages/core/src/executor/KernelPool.test.ts
bun test packages/core/src/agents/verifiers/BuildPassesVerifier.test.ts
```

**Why devtools is different**: It needs DOM environment (happy-dom). The `bunfig.toml` in
`packages/devtools/` configures this via a preload script (`src/setup-dom.ts`), but Bun only
reads `bunfig.toml` from the CWD where `bun test` is invoked.

**cloudflare-worker isolation**: The SSE resume test leaves a pending async operation that would
hang the process at ~90% CPU forever. `packages/cloudflare-worker/bunfig.toml` sets
`isolate = true` permanently — `bun test` is safe to call without any extra flags.

**CRITICAL: Never run any `bun test` as a background task** (`run_in_background`) — a hung test
will silently burn CPU for hours with no way to detect it.

## Lint

```bash
npx biome check packages/
npx biome check --write packages/    # auto-fix
```

## Build

```bash
npm run build          # build all packages via turbo
```

## Typecheck

```bash
npm run typecheck      # turbo run typecheck across all packages
```

## Integration tests

```bash
bun test tests/integration/
```

## Key new packages (2026-06-22 RLAIF)

| Module | Location |
|---|---|
| `RolloutForkRunner` | `packages/core/src/enhancement/RolloutForkRunner.ts` |
| `RolloutMemoryStore` | `packages/core/src/enhancement/RolloutMemoryStore.ts` |
| `KernelPool` | `packages/core/src/executor/KernelPool.ts` |
| `BuildPassesVerifier` | `packages/core/src/agents/verifiers/BuildPassesVerifier.ts` |
| `VisualAssertVerifier` | `packages/core/src/agents/verifiers/VisualAssertVerifier.ts` |
| `ScalarLLMJudgeVerifier` | `packages/core/src/agents/verifiers/ScalarLLMJudgeVerifier.ts` |
| `RolloutRanker` | `packages/core/src/ranking/RolloutRanker.ts` |
| `summarizeToolOutput` | `packages/core/src/agents/ToolOutputSummarizer.ts` |
| `RemoteSandboxKernel.runCommand` | `packages/kernel-remote/src/RemoteSandboxKernel.ts` |

## Compliance Engine (2026-06-24, Phase 0 + Phase 1 P0)

WasmAgent Compliance Engine — TaskSpec → ConstraintIR → Verifier → RepairTrace
pipeline. Lives at `packages/compliance/` (`@wasmagent/compliance`).

**Runtime compliance source of truth.** `ComplianceEvalRecord` is the canonical
cross-repo data contract consumed by evomerge for SFT/DPO/router training.
See [ecosystem-map](https://github.com/WasmAgent/evomerge/blob/main/docs/ecosystem-map.md).

### Package maturity

| Package | Maturity | Notes |
|---|---|---|
| `@wasmagent/core` | **Stable** | Public API; semver guaranteed |
| `@wasmagent/kernel-quickjs` | **Stable** | |
| `@wasmagent/kernel-remote` | **Stable** | |
| `@wasmagent/aisdk` / `@wasmagent/mastra-sandbox` | **Growth** | API stable, may add fields |
| `@wasmagent/compliance` | **Alpha** | Schema versioned; may add fields without breaking |
| `@wasmagent/evals-runner` | **Growth** | |
| `@wasmagent/devtools` | **Growth** | |

### Compliance modules

| Module | Location |
|---|---|
| `ConstraintIR` / `TaskSpec` types | `packages/compliance/src/ir/ConstraintIR.ts` |
| `ComplianceVerifier` | `packages/compliance/src/verifier/ComplianceVerifier.ts` |
| `IFEvalVerifier` (15 instruction classes) | `packages/compliance/src/verifier/ifeval/IFEvalVerifier.ts` |
| `DeterministicVerifier` (7 built-in checks) | `packages/core/src/agents/verifiers/DeterministicVerifier.ts` |
| `LLMJudgeVerifier` (adversarial binary) | `packages/core/src/agents/verifiers/LLMJudgeVerifier.ts` |
| `RepairPlanner` (escalation + rollback) | `packages/compliance/src/repair/RepairPlanner.ts` |
| `PatchStrategy` / `InsertSectionStrategy` / `RegenerateRegionStrategy` | `packages/compliance/src/repair/strategies/` |
| `ComplianceRun` (direct / prompt_retry / full_pcl) | `packages/compliance/src/runner/ComplianceRun.ts` |
| IFEval benchmark CLI (9 seeds complete) | `packages/compliance/benchmarks/ifeval/run.ts` |
| Multi-seed aggregator | `packages/compliance/benchmarks/ifeval/compare-seeds.ts` |
| Result data (1050 records) | `packages/compliance/benchmarks/ifeval/results*/` |
| Phase reports | `packages/compliance/benchmarks/ifeval/results-multi-seed*/*.md` |

**Headline empirical result**: on IFEval × Qwen2.5-1.5B-Q4, `full_pcl`
achieves 54.7% ± 1.2 pass-rate vs `prompt_retry` 46.0% ± 2.0 (+8.7 pp,
3 seeds × 50 samples). On Llama-3.2-1B, the picture is more complex —
PCL ties prompt_retry on mean but has 5× smaller variance. See
`packages/compliance/benchmarks/ifeval/results-multi-seed-llama/CROSS-MODEL-2026-06-24.md`.

Test it: `bun test packages/compliance/` (113 pass / 0 fail).
Reproduce sweep: `bun packages/compliance/benchmarks/ifeval/run.ts --limit=50 --seed=42`.

