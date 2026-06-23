# @wasmagent/aisdk

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
