---
"@wasmagent/core": patch
"@wasmagent/aep": patch
"@wasmagent/mcp-firewall": patch
"@wasmagent/compliance": patch
---

Align core-four package versions after the prior core-only bump (1.3.2) brought core out of lockstep with aep/mcp-firewall/compliance (still 1.3.1). Per scripts/check-version-coherence.mjs, the four core packages must share one version. This changeset bumps the other three to 1.3.2 (and will coordinate-bump core to 1.3.3, keeping all four aligned).
