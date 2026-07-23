---
"@wasmagent/core": patch
"@wasmagent/aep": major
"@wasmagent/mcp-firewall": major
"@wasmagent/compliance": major
---

Align core-four packages to the same major version (v3)

@wasmagent/aep, @wasmagent/mcp-firewall, and @wasmagent/compliance were left
at 1.x/2.x after the @wasmagent/core 3.0.0 release in #155. This changeset
brings all four to the same major so the version-coherence gate passes.

No API changes; the bump is structural only.
