---
"@wasmagent/core": minor
---

feat(core): `StateRecovery` — reconstruct agent runtime state from historical AEP evidence chains (Milestone 7, #274).

Adds `packages/core/src/state-recovery.ts`, enabling crash recovery and session resumption with full causality by replaying a run's durable evidence chain back into agent runtime state:

- **`StateRecovery.recover(store, runId, opts?)`** reads a run's records from an `EvidenceStore` (structural `RecoveryEvidenceSource`, duck-compatible with `@wasmagent/aep`'s `EvidenceStore`); **`recoverFromRecords(records, runId, opts?)`** reconstructs from an explicit, ordered record list.
- Returns a **`RecoveredState`**: the original task (recovered from a `task:`/`prompt:` input_ref, or overridable), best-effort model + sorted tool set, an ordered `Step[]` timeline (each tool call → a `ToolUseStep`, with error flags inferred from `outcome`/`exit_code`), the full **causality graph** (`action_id` → `parent_action_id` / `causal_chain_id`), record/action counts, time range, and a `chainIntegrity` verdict.
- **Chain integrity**: by default a lightweight structural fast path (ordering + `prev_record_hash` consistency); an optional caller-supplied `verifyChain` (e.g. aep's `verifyAEPChain`) upgrades to full hash-chain verification. `throwOnBrokenChain: false` reconstructs anyway from a truncated/incomplete chain — the typical crash-recovery case — and reports the break via `chainIntegrity`.
- **`toSnapshot(state, agentConfig?)`** bridges to the existing `AgentSnapshot` so a recovered run feeds straight into `restoreFromSnapshot()` for session resumption.
- Dependency boundary: imports `@wasmagent/aep` **types only** (no runtime dependency), mirroring `AgentGroup`'s evidence-layer relationship; `@wasmagent/core` consumers that never opt into evidence do not pull `@wasmagent/aep`.
