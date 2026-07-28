---
"@wasmagent/core": minor
---

Add `AgentGroup` orchestration primitive for multi-agent coordination with cross-linked evidence chains (Milestone 6). Unlike `AgentTeam` (best-of-n competition with a single winner), `AgentGroup` runs members as cooperators: every member contributes to an aggregated output, and the group mints a tamper-evident coordination record whose SHA-256 digest binds every member's contribution hash. New public exports: `AgentGroup`, `coordinationDigestFor`, `AGENT_GROUP_COORDINATION_TYPE`, and associated types (`AgentGroupOptions`, `AgentGroupResult`, `AgentGroupCoordinationRecord`, `AgentGroupEvidenceLink`, `AgentGroupEvidenceSink`, etc.). Accepts an optional structurally-typed `evidenceStore` (duck-compatible with `@wasmagent/aep`'s `EvidenceStore`) — zero runtime dependency on the evidence layer.
