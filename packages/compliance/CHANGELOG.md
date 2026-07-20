# @wasmagent/compliance


## 1.19.0

### Patch Changes

- Align version with core-four coherence policy

## 1.18.0

### Minor Changes

- chore: align core-four package versions to 1.17.0 (version coherence policy)

### Patch Changes

- Updated dependencies
  - @wasmagent/core@1.18.0

## 1.16.0

### Patch Changes

- 2606745: feat(aep): DSSE/in-toto attestation envelope for AEP v0.4 — industry-standard signature format
- Updated dependencies [2606745]
  - @wasmagent/core@1.16.0

## 1.15.0

### Patch Changes

- ba4b9f1: feat(core): StructuredMemory.get() options overload, FileStructuredKv durable backend
- Updated dependencies [ba4b9f1]
  - @wasmagent/core@1.15.0

## 1.14.1

### Patch Changes

- c08682d: fix: ApprovalStore runtime guard, emit() empty-actions throw, Finding type field, Promise detection
- Updated dependencies [c08682d]
  - @wasmagent/core@1.14.1

## 1.14.0

### Patch Changes

- ae0b2c9: feat(aep): AEPTimestamper interface and LocalTimestamper for external timestamp anchoring
- a68e8be: feat(core): ApprovalRequest type, ApprovalStore interface, InMemory and CF KV adapters
- Updated dependencies [ae0b2c9]
- Updated dependencies [a68e8be]
  - @wasmagent/core@1.14.0

## 1.13.1

### Patch Changes

- 7f3eecc: fix: deduplicate addCapabilityDecision, async resolveRepoCommit, tighten isStateChangingTool patterns
- Updated dependencies [7f3eecc]
  - @wasmagent/core@1.13.1

## 1.13.0

### Minor Changes

- d619b14: chore: align core-four package versions to 1.12.0

### Patch Changes

- Updated dependencies [d619b14]
  - @wasmagent/core@1.13.0

## 1.11.0

### Minor Changes

- d619b14: chore: align core-four package versions to 1.10.0

### Patch Changes

- Updated dependencies [d619b14]
  - @wasmagent/core@1.11.0

## 1.9.1

### Patch Changes

- 2df0159: chore: add SBOM generation and property-based testing (#44, #46)
- Updated dependencies [2df0159]
  - @wasmagent/core@1.9.1

## 1.9.0

### Minor Changes

- d849b83: feat: DX improvements + governance + mcp-firewall risk categories (#43, #45, #47, #48, #49)

### Patch Changes

- Updated dependencies [d849b83]
  - @wasmagent/core@1.9.0

## 1.8.0

### Minor Changes

- b87dded: feat(aep): implement v0.3 schema — side_effect_class, state_digest_kind, argument_drift, approval_mode (#7)

### Patch Changes

- Updated dependencies [b87dded]
  - @wasmagent/core@1.8.0

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

## 1.4.0

### Patch Changes

- Version bump for core-four lockstep coherence

## 1.3.4

### Patch Changes

- Align core-four package versions to 1.3.4
- Updated dependencies
  - @wasmagent/core@1.3.4

## 1.3.3

### Patch Changes

- 567cc30: Align core-four package versions after the prior core-only bump (1.3.2) brought core out of lockstep with aep/mcp-firewall/compliance (still 1.3.1). Per scripts/check-version-coherence.mjs, the four core packages must share one version. This changeset bumps the other three to 1.3.2 (and will coordinate-bump core to 1.3.3, keeping all four aligned).
- Updated dependencies [567cc30]
  - @wasmagent/core@1.3.3

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

- Updated dependencies [da249f9]
  - @wasmagent/core@1.3.1

## 1.3.0

### Minor Changes

- [`c3ccbca`](https://github.com/WasmAgent/wasmagent-js/commit/c3ccbca6fa5dd8e7ea97ed488dd238a1a57512e5) Thanks [@telleroutlook](https://github.com/telleroutlook)! - Bump @wasmagent/compliance to 1.2.0 to align with the core-four version
  coherence rule (core/aep/mcp-firewall/compliance all share the same
  version). No functional changes — this is a coordination-only bump that
  the pre-push hook (.githooks/pre-push) enforces from now on.
