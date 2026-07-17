# AEP Schema Contract (aep/v0.2)

The Agent Evidence Protocol (AEP) is the cross-repo evidence contract for the WasmAgent ecosystem. `AEPRecord` is emitted by `@wasmagent/aep` after every agent run and consumed by `trace-pipeline` (`evomerge`) for audit and training data export.

---

## Schema version: `aep/v0.2`

Current shipped contract (2026-06-26). Adds a **required** Ed25519 `signature` field; emitter now always signs records via `AEPSigner` (default: `LocalEd25519Signer`; KMS adapter slot reserved). v0.1 records are still parsed for backward compatibility but no longer produced.

New optional fields may be added without a version bump. Breaking changes require `aep/v0.3` and a migration script.

---

## `AEPRecord` fields

| Field | Type | Required | Description |
|---|---|---|---|
| `schema_version` | `"aep/v0.1" \| "aep/v0.2"` | **yes** | The literal schema tag. New emitters always write `"aep/v0.2"`. |
| `run_id` | `string` | **yes** | Unique identifier for this agent run |
| `created_at_ms` | `number` | **yes** | Unix epoch ms when the record was built |
| `trace_id` | `string` | no | OpenTelemetry-compatible trace ID for cross-signal correlation |
| `parent_trace_id` | `string \| null` | no | Parent trace ID for nested/multi-agent runs |
| `repo_commit` | `string` | no | Git commit SHA of the running code |
| `runtime_version` | `string` | no | `@wasmagent/core` version string |
| `model_provider` | `string` | no | e.g. `"anthropic"`, `"openai"` |
| `model_id` | `string` | no | e.g. `"claude-sonnet-4-6"` |
| `policy_bundle_digest` | `string` | no | sha256 hex of the `PolicyBundle` applied |
| `tool_manifest_digest` | `string` | no | sha256 hex of the MCP tool manifest used |
| `mcp_server_card_digest` | `string \| null` | no | sha256 hex of the `ServerCard` |
| `input_refs` | `InputRef[]` | no | Digested references to run inputs |
| `output_refs` | `OutputRef[]` | no | Digested references to run outputs |
| `capability_decisions` | `CapabilityDecision[]` | no | Policy decisions made during the run |
| `actions` | `ActionEvidence[]` | no | Evidence for each tool call |
| `verifier_results` | `VerifierResult[]` | no | Per-verifier pass/fail + score |
| `budget_ledger` | `BudgetLedger` | no | Budget consumption for tokens, latency, tools, risk, retries, human approvals |
| `signature` | `{ alg: "ed25519", key_id, sig }` | **yes (v0.2)** | Ed25519 cryptographic signature over the canonical bytes of the record. Required by `AEPRecordSchema` in `aep/v0.2`; verification via `verifyAEPRecord(record, publicKey)`. |

---

## `ActionEvidence` fields

| Field | Type | Required | Description |
|---|---|---|---|
| `action_id` | `string` | **yes** | Unique ID for this action |
| `tool_name` | `string` | **yes** | Name of the tool called |
| `state_changing` | `boolean` | **yes** | Whether this tool modifies external state |
| `timestamp_ms` | `number` | **yes** | Unix epoch ms when the action was taken |
| `precondition_digest` | `string` | no | sha256 of relevant state before the call |
| `result_digest` | `string` | no | sha256 of the tool's return value |
| `evidence_refs` | `string[]` | no | URIs to additional evidence artifacts |
| `capability_decision` | `CapabilityDecision` | no | The policy decision for this specific call |

---

## `CapabilityDecision` fields

| Field | Type | Required | Description |
|---|---|---|---|
| `capability` | `string` | **yes** | Capability name (typically tool name) |
| `subject` | `string` | **yes** | Who is requesting (e.g. `"agent"`) |
| `resource` | `string` | **yes** | What is being accessed |
| `decision` | `"allow" \| "deny" \| "ask_user" \| "dry_run"` | **yes** | Policy outcome |
| `reason_code` | `string` | no | Machine-readable reason (e.g. `"DENY_BLOCKED"`) |

---

## `BudgetLedger` fields

Each budget entry has `{ limit?: number, spent: number }`.

| Field | Type | Description |
|---|---|---|
| `token_budget` | `BudgetEntry` | LLM token consumption |
| `latency_budget` | `{ limit_ms?, actual_ms }` | Wall-clock latency |
| `tool_budget` | `BudgetEntry` | Number of tool calls |
| `risk_budget` | `BudgetEntry` | Risk units consumed (e.g. high-risk actions) |
| `retry_budget` | `BudgetEntry` | Number of retries |
| `human_approval_budget` | `BudgetEntry` | Human-in-the-loop approvals requested |

---

## Compatibility policy

| Change type | Handling |
|---|---|
| Add optional field to `AEPRecord` or `ActionEvidence` | Allowed without version bump |
| Add optional field to `CapabilityDecision` or `BudgetLedger` | Allowed without version bump |
| Add new required field | Requires `aep/v0.2` + migration script in `evomerge` |
| Remove any field | Requires `aep/v0.2` + deprecation period (min. 2 weeks) |
| Change enum values | Requires `aep/v0.2` |
| Change field type | Requires `aep/v0.2` |

---

## Example `AEPRecord`

```json
{
  "schema_version": "aep/v0.1",
  "run_id": "run-2026-06-26-001",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "model_provider": "anthropic",
  "model_id": "claude-sonnet-4-6",
  "policy_bundle_digest": "a3f4e2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2",
  "actions": [
    {
      "action_id": "act-001",
      "tool_name": "bash",
      "state_changing": false,
      "precondition_digest": "sha256-abc123",
      "result_digest": "sha256-def456",
      "evidence_refs": [],
      "capability_decision": {
        "capability": "bash",
        "subject": "agent",
        "resource": "bash",
        "decision": "allow"
      },
      "timestamp_ms": 1750950000000
    }
  ],
  "verifier_results": [
    {
      "verifier_id": "build-passes",
      "passed": true,
      "score": 1.0,
      "claim_ids": []
    }
  ],
  "budget_ledger": {
    "token_budget": { "limit": 10000, "spent": 3421 },
    "tool_budget": { "limit": 20, "spent": 4 }
  },
  "created_at_ms": 1750950001234
}
```

---

## What consumes AEP records

| Consumer | How |
|---|---|
| `evomerge validate-aep` | Schema validation + completeness gate (trace-pipeline) |
| `evomerge export` | Convert to SFT/DPO/PPO/router training data |
| `evomerge audit-report` | Generate Markdown audit report |
| `wasmagent evidence export` | CLI export to JSON/HTML report |
| `agent-evidence-gate` GitHub Action | CI validation + evidence artifact upload |

---

## Standards Alignment

AEP has been evaluated against the [AgentHook v0.2 draft](https://github.com/agenthook/spec) event model for agent runtime evidence. The full analysis is available in [RFC: AEP <-> AgentHook v0.2 Field Alignment](./rfcs/rfc-aep-agenthook-alignment.md).

**Key differentiators of AEP vs. AgentHook v0.2:**

- **Policy-first design** -- AEP records `policy_bundle_digest`, `tool_manifest_digest`, and structured `CapabilityDecision` arrays with approval modes. AgentHook models decisions as flat per-event fields without policy anchoring.
- **Budget accounting** -- AEP's `BudgetLedger` tracks six resource dimensions (tokens, latency, tools, risk, retries, human approvals). AgentHook has no equivalent.
- **Verifier results** -- AEP includes post-run verification verdicts (`verifier_results`) linking to specific claims. AgentHook does not model verification.
- **Tamper-evident chaining** -- AEP's `prev_record_hash` creates a hash-linked sequence of records. AgentHook events are independent.
- **Content-addressed by default** -- AEP digests inputs/outputs rather than storing raw content, supporting privacy-preserving audit. AgentHook stores full payloads in `model_call` and `tool_output`.
- **in-toto/DSSE wrapping** -- AEP records can serve as predicates inside in-toto attestation envelopes for supply-chain verification (see RFC for feasibility analysis).

AgentHook v0.2 offers `decision.confidence` scoring and `observation.trust_level` enums that AEP does not yet provide; these are candidates for AEP v0.4.

---

## Related

- [`@wasmagent/aep` package](../packages/aep/README.md) — `AEPEmitter`, `AEPRecord`, `BudgetLedger` TypeScript types
- [Trust Pack 30-min quickstart](./quickstarts/trust-pack-30min.md) — end-to-end usage
- [trace-pipeline evomerge](https://github.com/WasmAgent/trace-pipeline) — downstream consumer
- [RFC: AEP <-> AgentHook v0.2 Alignment](./rfcs/rfc-aep-agenthook-alignment.md) — field mapping and in-toto wrapping feasibility
