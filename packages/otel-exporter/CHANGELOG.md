# @agentkit-js/otel-exporter

## 2.0.0

### Minor Changes

- 2f377d5: feat(aep,otel-exporter): real-time evidence streaming with `EvidencePublisher` + OTLP transport (Milestone 7, #276).

  Adds a top-level real-time streaming surface for AEP evidence and an OpenTelemetry transport that mirrors the live feed into any OTLP/HTTP collector — the "real-time evidence streaming with `EvidencePublisher` for live monitoring dashboards and external observability pipelines (OpenTelemetry integration)" bullet.

  - **`@wasmagent/aep` — `EvidencePublisher`** (`packages/aep/src/evidencePublisher.ts`): wraps an `EvidenceStream` and adds (1) **push mode** — `publish(record)` streams each record to subscribers + transports, and (2) **watch mode** — `start()`/`stop()` poll a configured `EvidenceStore` on a fixed cadence and stream records appended _after_ start (never replaying the pre-existing tail), with an optional content `filter` applied to pulled records. Exposes `subscribe`/`addTransport` (live dashboards + any `StreamTransportOutbound`), lifecycle counters via `stats`, and a `close()` that tears down the underlying stream. Best-effort and fail-soft: a failing subscriber/transport or a transient store-query error is counted in `stats.errors` and never aborts the fan-out or stops the poll loop.
  - **`@wasmagent/otel-exporter` — `OtlpEvidenceTransport`** (`packages/otel-exporter/src/evidenceOtlpTransport.ts`): a `StreamTransportOutbound` that converts each record's actions into OTLP trace spans (reusing `aepActionToOtelSpan`, one span per action, all scoped to the run's trace id) and POSTs them to `<endpoint>/v1/traces` with exponential-backoff retry (5xx/network retryable, 4xx not). Also exports `aepRecordToOtlpSpans(record)` for inspecting the span projection without network access. References `@wasmagent/aep` **only via `import type`** (devDependency) — zero runtime dependency on the evidence layer, mirroring the `core/shared-state/aep` pattern.

### Patch Changes

- f1109a5: fix: three compatibility and dependency fixes (#288 #289 #290)

  - **useAgentRun** (`@wasmagent/react`): add `eventField` and `channelField` options so the hook works with Express/Node.js backends that emit `{ type, ... }` events instead of `{ event, ... }` (#288)
  - **createA2AServer** (`@wasmagent/a2a`): add `handler()` method returning a `(req, res)` handler compatible with Express `app.use()` middleware (#289)
  - **otel-exporter** (`@wasmagent/otel-exporter`): declare `@wasmagent/core` as a `peerDependency` so npm warns when it is missing; document the cross-package dependency on `@wasmagent/core/experimental` in the README (#290)

- Updated dependencies [b909b62]
  - @wasmagent/core@3.2.0

## 1.7.6

### Patch Changes

- Updated dependencies [8e19c52]
  - @wasmagent/core@3.1.1

## 1.7.5

### Patch Changes

- Updated dependencies [079ddbc]
- Updated dependencies [0263bde]
- Updated dependencies [7e823b0]
- Updated dependencies [fb6da9c]
  - @wasmagent/core@3.1.0

## 1.7.4

### Patch Changes

- Updated dependencies [e74c032]
  - @wasmagent/core@3.0.0

## 1.7.3

### Patch Changes

- Updated dependencies [6a62876]
  - @wasmagent/core@2.0.0

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
