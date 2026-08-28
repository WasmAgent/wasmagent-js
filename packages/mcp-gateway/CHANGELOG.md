# @wasmagent/mcp-gateway

## 0.1.13

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
  - @wasmagent/mcp-firewall@2.1.0

## 0.1.12

### Patch Changes

- @wasmagent/mcp-firewall@2.0.7

## 0.1.11

### Patch Changes

- @wasmagent/mcp-firewall@2.0.6

## 0.1.10

### Patch Changes

- @wasmagent/mcp-firewall@2.0.5

## 0.1.9

### Patch Changes

- @wasmagent/mcp-firewall@2.0.4

## 0.1.8

### Patch Changes

- @wasmagent/mcp-firewall@2.0.3

## 0.1.7

### Patch Changes

- @wasmagent/mcp-firewall@2.0.2

## 0.1.6

### Patch Changes

- @wasmagent/mcp-firewall@2.0.1

## 0.1.5

### Patch Changes

- Updated dependencies [0263bde]
- Updated dependencies [2985855]
  - @wasmagent/mcp-firewall@2.0.0

## 0.1.4

### Patch Changes

- Updated dependencies [e74c032]
  - @wasmagent/mcp-firewall@1.21.2

## 0.1.3

### Patch Changes

- @wasmagent/mcp-firewall@1.21.1

## 0.1.2

### Patch Changes

- @wasmagent/mcp-firewall@1.20.1

## 0.1.1

### Patch Changes

- @wasmagent/mcp-firewall@1.19.1
