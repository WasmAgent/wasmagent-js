# @wasmagent/compliance

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
