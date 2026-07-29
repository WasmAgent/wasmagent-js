---
"@wasmagent/mcp-posture": minor
---

feat(mcp-posture): new package — MCP attack-surface posture snapshot validator and drift analyzer

Migrated from WasmAgent/agent-trust-infra. Validates MCP Posture snapshot
documents against the canonical schema in @wasmagent/protocol, provides
risk taxonomy classification (ssrf, exfiltration, command_execution,
privilege_escalation, prompt_injection, credential_access, supply_chain,
mcp_header_leakage), and snapshot diff/alert engine.
