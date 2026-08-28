# @wasmagent/mcp-firewall

## 2.1.0

### Minor Changes

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

### Patch Changes

- @wasmagent/mcp-server@1.1.14

## 2.0.7

### Patch Changes

- @wasmagent/mcp-server@1.1.13

## 2.0.6

### Patch Changes

- @wasmagent/mcp-server@1.1.12

## 2.0.5

### Patch Changes

- @wasmagent/mcp-server@1.1.11

## 2.0.4

### Patch Changes

- @wasmagent/mcp-server@1.1.10

## 2.0.3

### Patch Changes

- @wasmagent/mcp-server@1.1.9

## 2.0.2

### Patch Changes

- @wasmagent/mcp-server@1.1.8

## 2.0.1

### Patch Changes

- Updated dependencies [8e19c52]
  - @wasmagent/mcp-server@1.1.7

## 2.0.0

### Major Changes

- 0263bde: Align core-four packages to the same major version (v3)

  @wasmagent/aep, @wasmagent/mcp-firewall, and @wasmagent/compliance were left
  at 1.x/2.x after the @wasmagent/core 3.0.0 release in #155. This changeset
  brings all four to the same major so the version-coherence gate passes.

  No API changes; the bump is structural only.

### Minor Changes

- 2985855: feat(mcp-firewall): detect descriptor mutation (rug-pull) in vetTool() (#168)

  - `vetTool()` accepts an optional `baseline` `ToolDescriptorSnapshot` (produced by `snapshotTool()` from `@wasmagent/mcp-server`). When supplied, it emits a `rug_pull` finding (`category`/`type` `rug_pull`, severity `high`, recommendation `ask`) for every descriptor field whose SHA-256 hash has drifted since first-seen — flagging the tool for re-review even when the new descriptor itself looks benign.
  - Completes the third static risk class for the MCP Firewall milestone: prompt injection, data exfiltration, and descriptor mutation risks.
  - `VetToolOptions` gains an optional `baseline` field and `vetToolAsync()` propagates it into the synchronous phase. Fully backward compatible: with no baseline supplied, `vetTool()` behaves exactly as before (no `rug_pull` findings).

### Patch Changes

- @wasmagent/mcp-server@1.1.6

## 1.21.2

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

  - @wasmagent/mcp-server@1.1.5

## 1.21.1

### Patch Changes

- @wasmagent/mcp-server@1.1.4

## 1.21.0

### Patch Changes

- Align version with core-four coherence policy

## 1.20.1

### Patch Changes

- @wasmagent/mcp-server@1.1.3

## 1.19.1

### Patch Changes

- @wasmagent/mcp-server@1.1.2

## 1.19.0

### Patch Changes

- Align version with core-four coherence policy

## 1.18.0

### Patch Changes

- Align version with core-four coherence policy

## 1.17.0

### Minor Changes

- 1038296: feat(mcp-firewall): pluggable semantic defense layer for paraphrase-based injection detection

  Adds a third detection phase (semantic similarity) to the vetting pipeline:

  - `SemanticDetector` interface for pluggable embedding models
  - `TfidfSemanticDetector` zero-dependency fallback using TF-IDF + cosine similarity
  - `vetToolAsync()` async vetting function that runs all three phases
  - `semantic_paraphrase` finding type for paraphrase-detected injections
  - Default malicious corpus covering 5 MCPTox-aligned categories

  Reference: CASCADE (arXiv:2604.17125), ZEDD (arXiv:2601.12359)

## 1.16.0

### Patch Changes

- 2606745: feat(aep): DSSE/in-toto attestation envelope for AEP v0.4 — industry-standard signature format

## 1.15.0

### Patch Changes

- ba4b9f1: feat(core): StructuredMemory.get() options overload, FileStructuredKv durable backend

## 1.14.1

### Patch Changes

- c08682d: fix: ApprovalStore runtime guard, emit() empty-actions throw, Finding type field, Promise detection

## 1.14.0

### Patch Changes

- ae0b2c9: feat(aep): AEPTimestamper interface and LocalTimestamper for external timestamp anchoring
- a68e8be: feat(core): ApprovalRequest type, ApprovalStore interface, InMemory and CF KV adapters

## 1.13.1

### Patch Changes

- 7f3eecc: fix: deduplicate addCapabilityDecision, async resolveRepoCommit, tighten isStateChangingTool patterns

## 1.12.0

### Minor Changes

- c391458: feat: run full adversarial detection on tool return values in taintObservation()

### Patch Changes

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

## 1.4.0

### Patch Changes

- Version bump for core-four lockstep coherence

## 1.3.4

### Patch Changes

- 76cbf87: fix(mcp-firewall): validate tool snapshot hash when evaluating consent, invalidating stale consent after tool descriptor changes

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

## 1.1.0

### Minor Changes

- feat: @wasmagent/mcp-firewall alpha — MCP runtime firewall with static vetting, per-call policy, taint tracking, and consent ledger

  - New package `@wasmagent/mcp-firewall@0.1.0`: vetTool(), evaluatePolicy(), taintObservation(), InMemoryConsentLedger
  - `@wasmagent/mcp-server`: export ToolDescriptorSnapshot, detectRugPull, snapshotTool, hashContent from toolDescriptorSnapshot.ts

### Patch Changes

- Updated dependencies []:
  - @wasmagent/mcp-server@1.1.0
