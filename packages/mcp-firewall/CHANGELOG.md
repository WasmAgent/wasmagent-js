# @wasmagent/mcp-firewall

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
