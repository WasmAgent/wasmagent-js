# @agentkit-js/devtools

## 1.7.2

### Patch Changes

- Updated dependencies [27571bf]
  - @wasmagent/core@1.21.0

## 1.7.1

### Patch Changes

- Updated dependencies [6553c88]
- Updated dependencies [1692c19]
- Updated dependencies [9df44c1]
  - @wasmagent/core@1.20.0

## 1.7.0

### Minor Changes

- d4a06f7: feat: standards-alignment features (#25-#30)

  - RecordingMode tri-state (validation/delta/full) on ActionEvidence (#26)
  - compileToRecordingPolicy for risk-driven AEP recording granularity (#28)
  - W3C PROV-DM causal graph + selectByDependency on EventLogReplay (#29)
  - OTEL_SEMCONV_STABILITY_OPT_IN support + GENAI_SEMCONV_VERSION (#30)

### Patch Changes

- Updated dependencies [d4a06f7]
  - @wasmagent/core@1.7.0

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
