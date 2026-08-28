# @agentkit-js/react

## 1.5.3

### Patch Changes

- 696744a: Comprehensive code-review fixes across the runtime (full-repo audit; 2,750+ tests green, 44/44 build).

  **core**

  - `model_done` now emits **per-step token deltas** instead of TokenBudget's cumulative run totals. Every consumer (GoalAgent / GoalDirectedAgent budget guards, AgentSupervisor, OtelBridge usage metrics, HealthMetrics) sums these as deltas — the old behaviour inflated totals by (N+1)/2× and terminated goal loops early with bogus `budget` outcomes.
  - `model_start` is now emitted by `ToolCallingAgent` before each `generate()` — OtelBridge chat spans and O2 usage metrics were dead code on the primary `withOtel(agent.run())` path.
  - `addRawMessage` records a `RawMessageStep` in assembler history: injected history no longer vanishes on `compact()`, `buildAsync` cache-index desync is fixed, `historyLength` counts injected turns so `run()` no longer resets them, and sealed-chunk breakpoints stay aligned.
  - `HealthMetrics` DAG-path instrumentation: per-tool latency recorded (was missing entirely on the default scheduler), serialisation failures counted, TimeoutError/AbortError classified as timeouts; parallel-path serialisation failures counted.
  - `GoalAgent` accepts `signal` (the GoalDirectedAgent was already passing it into the void); checked between iterations and forwarded to each inner run.
  - HITL: pending-approval checkpoint deleted on poll timeout (no more "approve a dead run" / KV leak); `InMemoryCheckpointer.load` returns a copy (caller mutation cannot forge approvals).
  - Leak fixes: OtelBridge `#traceIdMap` cleared in `forceFlush()`; SharedStateStore per-session lock chain tails deleted.

  **aep**

  - **Security**: `verifyAEPRecord` now binds the DSSE envelope to the record's inline fields (predicate canonical equality + subject digest/run binding). Previously, any field of a signed v0.4 record could be tampered with while verification still passed. Emitter stamps `schema_version: aep/v0.4` pre-signing; legacy v0.3-stamped predicates remain verifiable via documented normalisation.
  - `addAction({ action_id: undefined })` no longer clobbers generated defaults (spread-order bug killed `emit()` at zod validation).
  - `Ledger.compact()` reports `startedAtMs`/`endedAtMs` as min/max, not first/last element.

  **mcp-firewall**

  - **Security**: consent downgrade is principal-scoped — `evaluatePolicy` takes `userIdHash` and the gateway passes `identity.principalHash`, so one principal's approval no longer authorises every other principal.
  - `isStateChangingTool` covers 13 previously-missed mutating verbs (upload, install, import, drop, insert, truncate, rename, move, mkdir, patch, merge, kill, format, apply).
  - `argsDigest` uses sorted-key canonical JSON — key-order-independent receipt matching; BigInt-safe.
  - Vetting cache is LRU-capped (500); expired consent records pruned on insert; `leaseId` salted with `randomUUID()` (same-millisecond collisions impossible).

  **mcp-gateway**

  - `composeMiddleware` throws on a double `next()` call instead of silently re-running the downstream chain (double evidence emission).

  **cloudflare-worker**

  - Resume requests (`Last-Event-ID` / new `resumeTraceId` body field) now **replay-only** when the event log still has content — the previous behaviour replayed the tail and then re-executed the task (double model cost + duplicated stream). Empty log falls through to a live run (KV eventual consistency).
  - AG-UI SSE responses include `X-Agentkit-Trace-Id`; completed sessions are also written under the AG-UI `resume`/`threadId` alias key (that lookup could previously never hit).
  - `checkRateLimit` is wired into `POST /run` (opt-in via `WASMAGENT_RATE_LIMIT` binding, rpm via `WASMAGENT_RATE_LIMIT_RPM`, default 60); misleading fail-closed comment corrected.

  **react**

  - `useAgentRun`: a streamed `error` event is terminal (no retry after it) and `error` status is no longer clobbered to `idle` when attempts are exhausted; retry attempts reset the open text bubble and an SSE id-regression (server re-executed the run) resets accumulated state.

- Updated dependencies [696744a]
  - @wasmagent/core@3.7.0

## 1.5.2

### Patch Changes

- Updated dependencies [6bcdbc2]
  - @wasmagent/core@3.6.0

## 1.5.1

### Patch Changes

- Updated dependencies [c947fbf]
  - @wasmagent/core@3.5.0

## 1.5.0

### Minor Changes

- 2f93dfc: Address #307, #308, #309:

  - **core**: `ObservationalMemory` now auto-subscribes to assembler appends (`autoNote: true` by default) so agent loops no longer have to call `noteStep()` manually after each turn — the silent "forgot to call noteStep, session grows unbounded" failure mode is gone. Opt out with `autoNote: false`; call `dispose()` to detach. Enabled by a new `MessageAssembler.onStep()` subscription hook.
  - **aep**: `ToolCallRollup` / `buildToolRollups()` now include `error_count`, `error_rate`, and `outcome_distribution` alongside the existing counters, and the type + README are documented for audit-dashboard consumers.
  - **react**: `useAgentRun` accepts a header factory `(payload) => Record<string, string>` that receives the exact request body (including `resumeTraceId` on retries), so per-request values like panel session IDs can go in headers instead of the payload body.

### Patch Changes

- Updated dependencies [2f93dfc]
  - @wasmagent/core@3.4.0

## 1.4.2

### Patch Changes

- bbb7397: Internal: apply Biome import-ordering and formatting fixes to source files.
  No public API, type, or runtime behavior change.
- Updated dependencies [bbb7397]
  - @wasmagent/core@3.3.1

## 1.4.1

### Patch Changes

- 355c401: feat: four API enhancements (#302 #303 #304 #305)

  - compliance: verifyObject() for in-memory validation without WorkspaceReader
  - core: injectHistoryIntoAssembler promoted to exported API
  - aep: registerStatefulVerbs() unified verb registration
  - react: useAgentRun run() task field is now optional

- Updated dependencies [355c401]
  - @wasmagent/core@3.3.0

## 1.4.0

### Minor Changes

- 9bf3b9c: feat(react): add `eventMap` option to `useAgentRun` to remap custom event names to built-in handlers

  Backends that are structurally compatible with the Cloudflare Worker vocabulary
  but use different event _names_ (e.g. `text` instead of `text_delta`, `tool_start`
  instead of `tool_call`) can now opt in to the hook's built-in message accumulation
  without re-implementing it in `onEvent`.

  ```ts
  useAgentRun("/api/stream", {
    eventField: "type",
    channelField: null,
    eventMap: {
      text: "text_delta", // hook accumulates streaming text natively
      tool_start: "tool_call", // hook renders tool chip natively
      tool_end: "tool_result", // hook marks tool done natively
    },
    onEvent: (ev) => {
      // Only app-specific events remain here
      if (ev.type === "ui_action") dispatch(ev.action);
    },
  });
  ```

  The hook normalizes payloads for remapped events by reading both the standard
  nested `data.*` path and the flattened top-level fields (e.g. `ev.delta`,
  `ev.name`, `ev.call_id`) so backends that do not wrap their payload under `data`
  are handled automatically.

  Fixes #295

### Patch Changes

- @wasmagent/core@3.2.0

## 1.3.11

### Patch Changes

- f1109a5: fix: three compatibility and dependency fixes (#288 #289 #290)

  - **useAgentRun** (`@wasmagent/react`): add `eventField` and `channelField` options so the hook works with Express/Node.js backends that emit `{ type, ... }` events instead of `{ event, ... }` (#288)
  - **createA2AServer** (`@wasmagent/a2a`): add `handler()` method returning a `(req, res)` handler compatible with Express `app.use()` middleware (#289)
  - **otel-exporter** (`@wasmagent/otel-exporter`): declare `@wasmagent/core` as a `peerDependency` so npm warns when it is missing; document the cross-package dependency on `@wasmagent/core/experimental` in the README (#290)

- Updated dependencies [b909b62]
  - @wasmagent/core@3.2.0

## 1.3.10

### Patch Changes

- Updated dependencies [8e19c52]
  - @wasmagent/core@3.1.1

## 1.3.9

### Patch Changes

- Updated dependencies [079ddbc]
- Updated dependencies [0263bde]
- Updated dependencies [7e823b0]
- Updated dependencies [fb6da9c]
  - @wasmagent/core@3.1.0

## 1.3.8

### Patch Changes

- Updated dependencies [e74c032]
  - @wasmagent/core@3.0.0

## 1.3.7

### Patch Changes

- Updated dependencies [6a62876]
  - @wasmagent/core@2.0.0

## 1.3.6

### Patch Changes

- Updated dependencies [27571bf]
  - @wasmagent/core@1.21.0

## 1.3.5

### Patch Changes

- Updated dependencies [6553c88]
- Updated dependencies [1692c19]
- Updated dependencies [9df44c1]
  - @wasmagent/core@1.20.0

## 1.3.4

### Patch Changes

- c49a1be: fix(kernel-remote): harness now checks `__finalAnswer__`/`__final_answer__` sentinel variables, matching QuickJS/JS kernel behavior

  fix(cli): devtools server `listen()` now rejects on port-bind errors instead of hanging indefinitely

  fix(cli): `parseCrosswalkYaml` validates all required fields (id, risk, priority) before pushing entries

  fix(react): `useAgentRun` removes stale `status` from useCallback deps, uses `receivedFinalAnswer` flag for idle fallback

- Updated dependencies [07804a7]
  - @wasmagent/core@1.3.4

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

## 1.0.2

### Patch Changes

- useAgentRun: headers option now accepts `() => Record<string, string>` factory so session IDs can be injected on every reconnect

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
