# @wasmagent/mcp-firewall

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
