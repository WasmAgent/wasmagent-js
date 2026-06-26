---
"@wasmagent/core": patch
"@wasmagent/aep": patch
"@wasmagent/mcp-firewall": patch
"@wasmagent/compliance": patch
---

Align core/aep/mcp-firewall to v1.3.x to match the prior compliance
bump that landed in commit c3ccbca / release PR #5. Coordination-only
patch — no source changes. The version-coherence check in
scripts/check-version-coherence.mjs (and the pre-push hook) requires
the core-four packages (`core`, `aep`, `mcp-firewall`, `compliance`)
to share the same version, so all four must move together.

This is the correct bump type — `patch`, not `minor`, because there
is no new functionality, only a coordination bump.

After this release the four core packages will all be at v1.3.1.
