# @wasmagent/evals-runner

## 1.10.4

### Patch Changes

- e74c032: Update imports to use `@wasmagent/models` instead of `@wasmagent/core`

  Internal import path change only — no public API change. Adapter classes
  (`AnthropicModel`, `OpenAIModel`, `GenericOpenAICompatModel`, `FallbackModel`)
  moved to `@wasmagent/models` as part of the #123 extraction.

- Updated dependencies [e74c032]
  - @wasmagent/core@3.0.0
  - @wasmagent/models@2.0.0
  - @wasmagent/devtools@1.7.4

## 1.10.3

### Patch Changes

- Updated dependencies [6a62876]
  - @wasmagent/core@2.0.0
  - @wasmagent/devtools@1.7.3

## 1.10.2

### Patch Changes

- Updated dependencies [27571bf]
  - @wasmagent/core@1.21.0
  - @wasmagent/devtools@1.7.2

## 1.10.1

### Patch Changes

- Updated dependencies [6553c88]
- Updated dependencies [1692c19]
- Updated dependencies [9df44c1]
  - @wasmagent/core@1.20.0
  - @wasmagent/devtools@1.7.1

## 1.10.0

### Minor Changes

- 8c9cd5d: feat: rollout tree topology, SFT annotator, symmetric memory, and linearisation ablation benchmark

  - RolloutTreeExporter: serialise fork-point topology for step-level DPO credit assignment (#69)
  - RolloutSFTAnnotator: score-based high_value turn detection without named pattern enumeration (#70)
  - Linearisation ablation benchmark suite in evals-runner with 4 serialization variants (#71)
  - RolloutMemoryStore: symmetric trajectory memory with includeAllScores option (#72)

### Patch Changes

- Updated dependencies [8c9cd5d]
  - @wasmagent/core@1.10.0

## 1.0.3

### Patch Changes

- [`ac58faa`](https://github.com/WasmAgent/wasmagent-js/commit/ac58faa7948f91defa979dc1f5e37fa8ee66d847) Thanks [@telleroutlook](https://github.com/telleroutlook)! - Brand, schema, tier metadata, adapter quickstarts, security defaults, eval-trust report generator

  - Rename all `AGENTKIT_*` env vars → `WASMAGENT_*` (model-local)
  - Add `objective_status: 'pass'|'fail'|'unknown'` to rollout-wire schema
  - Add `wasmagent.{tier,stability}` maintenance tier metadata to all 33 packages
  - Add `docs/api/stability-policy.md` and `stable-exports.md` (275 stable exports)
  - Add `Before / After` diff + `Security demo` sections to 5 adapter READMEs
  - Add 5 quickstart example directories (aisdk, mastra-sandbox, openai-agents, claude-agent-sdk, mcp-server)
  - Add `scripts/check-release-cadence.mjs` CI gate
  - Add `scripts/e2e-data-loop.mjs` end-to-end pipeline validation script
  - README first screen: three-layer product structure (Core Runtime / Integrations / Trust Data)
  - CHANGELOG: three-tier format (Stable / Beta / Experimental)

- Updated dependencies [[`ac58faa`](https://github.com/WasmAgent/wasmagent-js/commit/ac58faa7948f91defa979dc1f5e37fa8ee66d847)]:
  - @wasmagent/core@1.0.3
  - @wasmagent/devtools@1.0.3

## 1.0.0

### Minor Changes

- feat: RLAIF ranking, beta/experimental subpaths, stable API gate, security fixes

  - RolloutForkRunner, RolloutRanker, BuildPassesVerifier, VisualAssertVerifier, ScalarLLMJudgeVerifier
  - KernelPool, RolloutMemoryStore, ToolOutputSummarizer
  - @wasmagent/core/beta and @wasmagent/core/experimental subpath exports
  - ApprovalPolicy, ApprovalRule, WriteOpKind, PolicyPresets, applyApprovalPolicy
  - BuildResult, VisualResult types for bscode adapter
  - Stable API snapshot gate and bundle budget checks in CI

### Patch Changes

- Updated dependencies []:
  - @wasmagent/core@1.0.0
  - @wasmagent/devtools@1.0.0
