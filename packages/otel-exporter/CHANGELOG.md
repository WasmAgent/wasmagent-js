# @agentkit-js/otel-exporter

## 1.0.1

### Patch Changes

- Post-session patch: API tier split, security hardening, and brand unification

  - core: beta.ts adds FileTreeManager/globalFileTree/globalFileLock exports; ProgrammaticOrchestrator gains safety options; stable API check improved
  - aisdk: agentkitCodemodeExecutor renamed to createCodemodeExecutor; AgentkitCodemodeExecutorOptions renamed to CodemodeExecutorOptions
  - mastra-sandbox: agentkitMastraSandbox renamed to createMastraSandbox
  - mcp-server: fetchHandler gains auth hook, maxBodyBytes, maxBatchSize; binary renamed wasmagent-mcp-server
  - cli: rank-rollout command added; agentkit-evals binary renamed wasmagent-evals; fix import from core/beta
  - otel-exporter: import types from @wasmagent/core/experimental (correct sub-path)

- Updated dependencies []:
  - @wasmagent/core@1.0.1

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

## 0.2.0

### Minor Changes

- [`8c7d015`](https://github.com/telleroutlook/agentkit-js/commit/8c7d015ef3a0ab3f10e48b593be44fd106d6b433) Thanks [@claude](https://github.com/claude)! - First public npm release.

  - All 26 publishable packages now carry standard npm metadata: `repository`,
    `homepage`, `bugs`, `engines`, `license` (Apache-2.0), `publishConfig`,
    per-package `LICENSE`, and a `files` whitelist.
  - Inter-package dependencies still use `workspace:*` in source — `changeset publish` rewrites them to semver at pack time.
  - `@agentkit-js/cloudflare-worker` remains private and ships only via Workers deploy.

### Patch Changes

- Updated dependencies [[`8c7d015`](https://github.com/telleroutlook/agentkit-js/commit/8c7d015ef3a0ab3f10e48b593be44fd106d6b433)]:
  - @agentkit-js/core@0.2.0
