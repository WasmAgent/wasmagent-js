# @wasmagent/aep

## 2.4.1

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

## 2.4.0

### Minor Changes

- 2f93dfc: Address #307, #308, #309:

  - **core**: `ObservationalMemory` now auto-subscribes to assembler appends (`autoNote: true` by default) so agent loops no longer have to call `noteStep()` manually after each turn — the silent "forgot to call noteStep, session grows unbounded" failure mode is gone. Opt out with `autoNote: false`; call `dispose()` to detach. Enabled by a new `MessageAssembler.onStep()` subscription hook.
  - **aep**: `ToolCallRollup` / `buildToolRollups()` now include `error_count`, `error_rate`, and `outcome_distribution` alongside the existing counters, and the type + README are documented for audit-dashboard consumers.
  - **react**: `useAgentRun` accepts a header factory `(payload) => Record<string, string>` that receives the exact request body (including `resumeTraceId` on retries), so per-request values like panel session IDs can go in headers instead of the payload body.

## 2.3.1

### Patch Changes

- bbb7397: Internal: apply Biome import-ordering and formatting fixes to source files.
  No public API, type, or runtime behavior change.

## 2.3.0

### Minor Changes

- 355c401: feat: four API enhancements (#302 #303 #304 #305)

  - compliance: verifyObject() for in-memory validation without WorkspaceReader
  - core: injectHistoryIntoAssembler promoted to exported API
  - aep: registerStatefulVerbs() unified verb registration
  - react: useAgentRun run() task field is now optional

## 2.2.0

### Minor Changes

- f26844d: feat(aep): `EvidenceCompressor` — auditable summaries and cryptographic fingerprints from long evidence chains (Milestone 7, #272).

  Adds a stateless `EvidenceCompressor` class to `@wasmagent/aep` that reduces a sequence of `AEPRecord`s into a compact `CompressedChainSummary` enabling efficient storage and fast verification without sacrificing chain integrity:

  - **`EvidenceCompressor.compress(records, options?)`** — produces a `CompressedChainSummary` with: a SHA-256 Merkle-like `chainFingerprint` over per-record canonical hashes (order-sensitive; any tamper invalidates it), `firstRecordHash` / `lastRecordHash` anchors for chain linking, aggregated `toolStats` (per-tool call counts, state-changing counts, side-effect and outcome distributions), `decisionStats` (allow/deny/ask_user/dry_run totals), `budgetTotals` (tokens/tools/risk/retries/human-approvals summed), time range (`startedAtMs`/`endedAtMs`), distinct `runIds`, and an optional `label`.
  - **`EvidenceCompressor.verifyChainFingerprint(records, expected)`** — static helper to re-derive the fingerprint from records and compare against a stored summary; answers "is this chain intact?" without re-reading every field.

## 2.1.0

### Minor Changes

- 2f377d5: feat(aep,otel-exporter): real-time evidence streaming with `EvidencePublisher` + OTLP transport (Milestone 7, #276).

  Adds a top-level real-time streaming surface for AEP evidence and an OpenTelemetry transport that mirrors the live feed into any OTLP/HTTP collector — the "real-time evidence streaming with `EvidencePublisher` for live monitoring dashboards and external observability pipelines (OpenTelemetry integration)" bullet.

  - **`@wasmagent/aep` — `EvidencePublisher`** (`packages/aep/src/evidencePublisher.ts`): wraps an `EvidenceStream` and adds (1) **push mode** — `publish(record)` streams each record to subscribers + transports, and (2) **watch mode** — `start()`/`stop()` poll a configured `EvidenceStore` on a fixed cadence and stream records appended _after_ start (never replaying the pre-existing tail), with an optional content `filter` applied to pulled records. Exposes `subscribe`/`addTransport` (live dashboards + any `StreamTransportOutbound`), lifecycle counters via `stats`, and a `close()` that tears down the underlying stream. Best-effort and fail-soft: a failing subscriber/transport or a transient store-query error is counted in `stats.errors` and never aborts the fan-out or stops the poll loop.
  - **`@wasmagent/otel-exporter` — `OtlpEvidenceTransport`** (`packages/otel-exporter/src/evidenceOtlpTransport.ts`): a `StreamTransportOutbound` that converts each record's actions into OTLP trace spans (reusing `aepActionToOtelSpan`, one span per action, all scoped to the run's trace id) and POSTs them to `<endpoint>/v1/traces` with exponential-backoff retry (5xx/network retryable, 4xx not). Also exports `aepRecordToOtlpSpans(record)` for inspecting the span projection without network access. References `@wasmagent/aep` **only via `import type`** (devDependency) — zero runtime dependency on the evidence layer, mirroring the `core/shared-state/aep` pattern.

## 2.0.1

### Patch Changes

- 8e19c52: fix: three correctness bugs (issues #281 #282 #283)

  - **detectRugPull** (`@wasmagent/mcp-server`): returns `null` instead of throwing `TypeError` when `curr.description` is missing (e.g. caller passes a snapshot object instead of a raw `McpToolEntry`)
  - **isStateChangingTool** (`@wasmagent/aep`): expanded `STATE_CHANGING_PATTERNS` with `convert`, `approve`, `reject`, `insert`, `patch`, and `apply` — common domain verbs that were previously classified as read-only
  - **estimateMessagesTokens** (`@wasmagent/core`): accepts `null`/`undefined` input and returns `0` instead of throwing `TypeError: messages is not iterable`

## 2.0.0

### Major Changes

- 0263bde: Align core-four packages to the same major version (v3)

  @wasmagent/aep, @wasmagent/mcp-firewall, and @wasmagent/compliance were left
  at 1.x/2.x after the @wasmagent/core 3.0.0 release in #155. This changeset
  brings all four to the same major so the version-coherence gate passes.

  No API changes; the bump is structural only.

### Minor Changes

- e0e0220: feat(aep): capture tool outcome, exit code, and arguments digest in addAction (#163)

  - `ActionEvidence` gains three optional fields — `outcome`, `exit_code`, and `arguments_digest` — so `AEPEmitter.addAction()` can capture the full tool-call evidence set: tool name, outcome, exit code, arguments hash, and result hash (`result_digest`). Fields are optional and backward compatible; existing records and callers are unaffected.

- 73f33c8: feat(aep): real-time evidence monitoring hooks — webhook subscriptions, WebSocket streaming, and in-process compliance-dashboard observers (Milestone 6, #265).

  Adds `packages/aep/src/evidenceMonitor.ts`, building on the `EvidenceStream` pub/sub primitives with three ready-to-use monitoring hook types plus a unified container:

  - **Webhook subscriptions** — `WebhookMonitorHook` (implements `StreamTransportOutbound`): POSTs each evidence event to one or more HTTPS URLs with HMAC-SHA-256 signing (`X-Wasmagent-Signature`), exponential-backoff retries, an SSRF guard (`validateWebhookUrl` rejects private/internal ranges and non-HTTPS schemes at construction time), an optional dead-letter backend, and a configurable payload transform (`defaultWebhookPayload` hoists `run_id`/`model_id` and nests the full record).
  - **WebSocket streaming** — `WebSocketMonitorHook`: serializes each event onto a `WebSocketLike` connection; events arriving while the socket is not yet open are counted as dropped (`droppedCount`/`sentCount`/`lastError`) and never abort the surrounding publish fan-out.
  - **In-process observers** — `ComplianceDashboardObserver`: aggregates matching events into a `ComplianceDashboardSnapshot` (counts by `run_id`, `tool_name`, `side_effect_class`, and `model_id`, plus a bounded rolling `recent` window and first/last-seen timestamps) that compliance dashboards read synchronously, with `reset()` and an optional `onEvent` callback.
  - **`EvidenceMonitor`** — a thin container wiring all three hook types onto a single `EvidenceStream` via `addWebhook` / `addWebSocket` / `observe`, with shared `publish` and `close` lifecycle.

  All hooks are filter-aware (reusing `matchesFilter` query semantics) and best-effort: a failing hook never blocks delivery to the others.

## 1.21.1

### Patch Changes

- e74c032: Extract model adapters into `@wasmagent/models` (closes #123)

  **Breaking:** `AnthropicModel`, `OpenAIModel`, `OpenAICompatModel`, `GenericOpenAICompatModel`, `FallbackModel`, and `RetryPolicy` are no longer exported from `@wasmagent/core` or `@wasmagent/core/models`.

  Migrate your imports:

  ```ts
  // Before
  import { AnthropicModel, FallbackModel } from "@wasmagent/core";
  import { OpenAICompatModel } from "@wasmagent/core/models";

  // After
  import {
    AnthropicModel,
    FallbackModel,
    OpenAICompatModel,
  } from "@wasmagent/models";
  // Or use subpaths for tree-shaking:
  import { AnthropicModel } from "@wasmagent/models/anthropic";
  import { DeepSeekModel } from "@wasmagent/models/deepseek";
  ```

  `@wasmagent/core/models` now exports only the stable contracts (`Model`, `ModelMessage`, `GenerateOptions`, `StreamEvent`, `ModelCapabilities`, `ModelRegistry`, `TokenBudget`, `repairJson`, and related types). The volatile provider adapters live in `@wasmagent/models` so that provider-SDK churn no longer forces a `@wasmagent/core` release that ripples to all 40+ downstream packages.

  The `model-*` packages (`@wasmagent/model-anthropic`, `@wasmagent/model-openai`, etc.) are now thin re-export shims pointing at `@wasmagent/models`. They remain published for backwards compatibility but are deprecated — migrate directly to `@wasmagent/models`.

  `@wasmagent/model-local` is unchanged (standalone native peer dependency).

## 1.21.0

### Patch Changes

- Align version with core-four coherence policy

## 1.19.0

### Patch Changes

- Align version with core-four coherence policy

## 1.18.0

### Minor Changes

- chore: align core-four package versions to 1.17.0 (version coherence policy)

## 1.16.0

### Minor Changes

- 2606745: feat(aep): DSSE/in-toto attestation envelope for AEP v0.4 — industry-standard signature format

## 1.15.0

### Patch Changes

- ba4b9f1: feat(core): StructuredMemory.get() options overload, FileStructuredKv durable backend

## 1.14.1

### Patch Changes

- c08682d: fix: ApprovalStore runtime guard, emit() empty-actions throw, Finding type field, Promise detection

## 1.14.0

### Minor Changes

- ae0b2c9: feat(aep): AEPTimestamper interface and LocalTimestamper for external timestamp anchoring

### Patch Changes

- a68e8be: feat(core): ApprovalRequest type, ApprovalStore interface, InMemory and CF KV adapters

## 1.13.1

### Patch Changes

- 7f3eecc: fix: deduplicate addCapabilityDecision, async resolveRepoCommit, tighten isStateChangingTool patterns

## 1.12.0

### Minor Changes

- 6f28170: feat: add inter-record hash chain (prev_record_hash) and verifyAEPChain()

## 1.11.0

### Minor Changes

- d619b14: chore: align core-four package versions to 1.10.0

## 1.9.1

### Patch Changes

- 2df0159: chore: add SBOM generation and property-based testing (#44, #46)

## 1.9.0

### Minor Changes

- d849b83: feat: DX improvements + governance + mcp-firewall risk categories (#43, #45, #47, #48, #49)

## 1.8.0

### Minor Changes

- b87dded: feat(aep): implement v0.3 schema — side_effect_class, state_digest_kind, argument_drift, approval_mode (#7)

## 1.7.0

### Minor Changes

- d4a06f7: feat: standards-alignment features (#25-#30)

  - RecordingMode tri-state (validation/delta/full) on ActionEvidence (#26)
  - compileToRecordingPolicy for risk-driven AEP recording granularity (#28)
  - W3C PROV-DM causal graph + selectByDependency on EventLogReplay (#29)
  - OTEL_SEMCONV_STABILITY_OPT_IN support + GENAI_SEMCONV_VERSION (#30)

- 4f1ed76: feat(aep): resolve issues #18-#23

  - Export `isStateChangingTool()` and `STATE_CHANGING_PATTERNS` from new utils module (#23)
  - Add `session_id` and `turn_index` fields to RunContext for multi-turn audit trails (#22)
  - PermissionGate schema for system permission layer signaling (#21)
  - `user_id` and `subject_id` on AEPRecord for cross-run behavior audit (#20)
  - `created_at_ms` in AEPEmitterOptions for ergonomic timestamp seeding (#19)
  - Regenerated JSON Schema with all new fields; added Python emitter example (#18)

## 1.5.0

### Minor Changes

- 8fc95fc: feat(aep): add JSON Schema export, timestamp override in addAction, user_id/subject_id fields, and permission_gate signal

  - #18: Export AEP schema as JSON Schema for non-TS consumers + Python emitter example
  - #19: addAction accepts optional timestamp_ms for historical data seeding
  - #20: AEPRecord gains optional user_id and subject_id for cross-run audit
  - #21: Actions can carry permission_gate to signal platform-level authorization

## 1.4.0

### Patch Changes

- e34751a: docs(aep): describe run-provenance fields (repo_commit, runtime_version, policy_bundle_digest, tool_manifest_digest) and how downstream consumers anchor a record back to the code, runtime, policy ruleset and tool manifest in effect at run time. Adds an explicit regression test that pins the constructor → record transport for the four fields and confirms they are inside the signed payload.

  Refs: WasmAgent/wasmagent-js#12

- 70f111f: fix(aep): use Date.now() instead of performance.now() for default timestamps

  - `emit()` / `build()` now defaults `created_at_ms` to `Date.now()` (Unix epoch ms) instead of `performance.now()` (ms since process start). Fixes records showing `1970-01-01` in downstream audit tools.
  - `addAction()` without explicit `timestamp_ms` also defaults to `Date.now()`.
  - `addAction()` with `capability_decision` now auto-registers to `capability_decisions[]` (deduped), fixing silent empty manifest in downstream `toEvents()`.

  Fixes: #14, #15

## 1.3.4

### Patch Changes

- Align core-four package versions to 1.3.4

## 1.3.3

### Patch Changes

- 567cc30: Align core-four package versions after the prior core-only bump (1.3.2) brought core out of lockstep with aep/mcp-firewall/compliance (still 1.3.1). Per scripts/check-version-coherence.mjs, the four core packages must share one version. This changeset bumps the other three to 1.3.2 (and will coordinate-bump core to 1.3.3, keeping all four aligned).

## 1.3.1

### Patch Changes

- da249f9: Align core/aep/mcp-firewall to v1.3.x to match the prior compliance
  bump that landed in commit c3ccbca / release PR #5. Coordination-only
  patch — no source changes. The version-coherence check in
  scripts/check-version-coherence.mjs (and the pre-push hook) requires
  the core-four packages (`core`, `aep`, `mcp-firewall`, `compliance`)
  to share the same version, so all four must move together.

  This is the correct bump type — `patch`, not `minor`, because there
  is no new functionality, only a coordination bump.

  After this release the four core packages will all be at v1.3.1.

## 1.2.0

### Minor Changes

- [`b044b6a`](https://github.com/WasmAgent/wasmagent-js/commit/b044b6af1da055849e62007319d400bf55ead8ef) Thanks [@telleroutlook](https://github.com/telleroutlook)! - Security audit fixes (technical review 2026-06-26).

  **@wasmagent/aep — v0.2 signature contract**

  - New `canonical.ts` produces deterministic canonical bytes for signing.
  - New `signer.ts` with `LocalEd25519Signer` and the `AEPSigner` interface (KMS-adapter slot reserved).
  - New `verify.ts` exposes `verifyAEPRecord(record, publicKey)`; checks Ed25519 signature and recomputes digests.
  - The `signature` field on `AEPRecord` is now part of the v0.2 schema; emit() requires a signer, build() falls back to a placeholder marked `UNSIGNED_PLACEHOLDER` for sync test helpers.
  - README documents the v0.2 signature contract.

  **@wasmagent/mcp-firewall — TaintedObservation render + consent/vetting cache hardening**

  - `renderTaintedObservation()` now emits a JSON-structured envelope with base64-encoded content; tool names must match `^[A-Za-z0-9_.-]+$` before rendering.
  - `ConsentRecord` cache key now binds `(name, descriptionHash, inputSchemaHash, serverIdentity, toolSnapshotHash)` — any field change invalidates consent (rug-pull defence).
  - `vetTool()` cache key follows the same composite.
  - New `vetting-corpus.ts` with ≥ 50 adversarial samples across 8 categories (Russian, Chinese, Base64, homoglyph, zero-width, obfuscation, jailbreak).
  - New `evaluateAdversarial()` second-stage n-gram logistic classifier feeding a risk floor into policy evaluation.
  - `prompt-injection-adversarial.test.ts` reports per-category detection rate; `w3-security.test.ts` anchors the new cache-key invariants.

  **@wasmagent/kernel-wasmtime — envelope, state-restore guard, javy autoinstall**

  - Host-side envelope protocol: stdout bytes only accepted when prefixed with `WASMAGNT` magic + uint32 length; HMAC over `(run_id, stdout_bytes)` proves authorship.
  - State-restore reserved-key whitelist (symmetric with save phase) — attempts to overwrite `fetch`, `__check_host__`, `Reflect`, `Proxy`, etc. are rejected and audit-logged.
  - `fd_write` failures no longer return synthetic success.
  - New `scripts/postinstall.mjs` downloads the platform-correct `javy` static binary into `packages/kernel-wasmtime/vendor/` on `bun install`.

  **@wasmagent/kernel-quickjs — global guard freezing**

  - `__check_host__` and host-allowlist functions are now installed with `Object.defineProperty(..., {configurable:false, writable:false})`; in-sandbox reassignment or deletion no longer bypasses host check.
  - Regression tests cover override / delete attempts.

  **Related, not bumping packages here:**

  - `@wasmagent/cloudflare-worker` JWT now requires `exp`, `iss`, `aud` and supports an optional revocation list. The worker is on the changeset `ignore` list — it ships via the Wrangler deploy, not via npm.
  - `@wasmagent/core` carries the version bump only to keep the linked group coherent — no API change.

  **Engineering hygiene**

  - Root scripts: `check-version-coherence.mjs` enforces that all `@wasmagent/*` workspace dependency ranges resolve against the locally pinned versions.
  - README adopts the `stable | beta | alpha | demo | research` maturity ladder; each `package.json` `wasmagent.stability` field aligned.

  **Reference**: WasmAgent Technical Review Report 2026-06-26 — P0-1, P0-7, P0-9, P0-10; P1-4, P1-6, P1-9, P1-11.
