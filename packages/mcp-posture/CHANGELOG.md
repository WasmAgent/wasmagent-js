# @wasmagent/mcp-posture

## 0.2.4

### Patch Changes

- 2428924: Widen the `@wasmagent/protocol` dependency from the exact pin `0.1.7` to `^0.1.9`. The exact pin forced bun/npm to nest a second 0.1.7 copy inside every consumer that had already moved to 0.1.9 (observed in agentbom's lockfile), defeating dedupe and freezing consumers on the pre-attribution canonical schema.

## 0.2.3

### Patch Changes

- c947fbf: Add the package README and Apache-2.0 LICENSE that the publish-readiness gate requires; no runtime changes.

## 0.2.2

### Patch Changes

- 2f93dfc: Add the package README and Apache-2.0 LICENSE that the publish-readiness gate requires; no runtime changes.

## 0.2.1

### Patch Changes

- bbb7397: Internal: apply Biome import-ordering and formatting fixes to source files.
  No public API, type, or runtime behavior change.

## 0.2.0

### Minor Changes

- 8103009: feat(mcp-posture): new package — MCP attack-surface posture snapshot validator and drift analyzer

  Migrated from WasmAgent/agent-trust-infra. Validates MCP Posture snapshot
  documents against the canonical schema in @wasmagent/protocol, provides
  risk taxonomy classification (ssrf, exfiltration, command_execution,
  privilege_escalation, prompt_injection, credential_access, supply_chain,
  mcp_header_leakage), and snapshot diff/alert engine.
