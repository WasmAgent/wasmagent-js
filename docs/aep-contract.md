# AEP Schema Contract (aep/v0.3)

The Agent Evidence Protocol (AEP) is the cross-repo evidence contract for the WasmAgent ecosystem. `AEPRecord` is emitted by `@wasmagent/aep` after every agent run and consumed by `trace-pipeline` (`evomerge`) for audit and training data export. New emitters build `aep/v0.3` records; when the emitter is configured with `useDsse: true`, `emit()` produces `aep/v0.4` DSSE/in-toto envelopes.

---

## Schema version: `aep/v0.3`

Current shipped contract. `aep/v0.3` builds on the v0.2 schema — which introduced the **required** Ed25519 `signature` field (the emitter always signs records via `AEPSigner`; default `LocalEd25519Signer`, KMS adapter slot reserved) — and adds:

- `recording_mode` and `side_effect_class` on every `ActionEvidence` (defaults `"validation"` / `"unknown"`)
- run-level `run_side_effect_class_max`
- `state_digest_kind` / `state_digest_coverage` state-digest metadata
- `argument_drift` detection
- `approval_mode` / `approval_extension` / `deny_reason_class` on `CapabilityDecision`
- external `timestamp_proof` via `AEPTimestamper`
- `session_id` / `turn_index` run context

**`aep/v0.4`** is the DSSE/in-toto emission variant: when the emitter is constructed with `useDsse: true`, `emit()` wraps the record in a DSSE envelope (`dsse_envelope`), signs the envelope via PAE, and stamps `schema_version: "aep/v0.4"` while still populating the legacy `signature` field for backward compatibility.

v0.1 and v0.2 records are still parsed for backward compatibility but no longer produced. New emitters always write `"aep/v0.3"` (or `"aep/v0.4"` when DSSE emission is enabled).

New optional fields may be added without a version bump. Breaking changes require `aep/v0.4` (or later) and a migration script.

---

## `AEPRecord` fields

| Field | Type | Required | Description |
|---|---|---|---|
| `schema_version` | `"aep/v0.1" \| "aep/v0.2" \| "aep/v0.3" \| "aep/v0.4"` | **yes** | The literal schema tag. New emitters always write `"aep/v0.3"` (or `"aep/v0.4"` when emitting a DSSE-signed record via `useDsse`). |
| `run_id` | `string` | **yes** | Unique identifier for this agent run |
| `user_id` | `string` | no | User identity for cross-run behavior audit |
| `subject_id` | `string` | no | Subject identity for cross-run behavior audit |
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
| `prev_record_hash` | `string \| null` | no | sha256 hex of the canonical previous record (excluding its signature); set automatically by the emitter to build a hash-linked chain |
| `run_context` | `RunContext` | no | Execution environment and delegation metadata (`agent_id`, `session_id`, `turn_index`, `delegation_chain`, environment/dependency digests) |
| `run_side_effect_class_max` | `SideEffectClass` | no | Highest `side_effect_class` observed across the run; computed automatically by the emitter (v0.3) |
| `timestamp_proof` | `{ timestamp, authority, proof, logIndex? }` | no | External timestamp proof attached by an `AEPTimestamper` after signing (v0.3) |
| `signature` | `{ alg: "ed25519", key_id, sig }` | **yes (since v0.2)** | Ed25519 cryptographic signature over the canonical bytes of the record. Required by `AEPRecordSchema` since `aep/v0.2`; verification via `verifyAEPRecord(record, publicKey)`. On `aep/v0.4` records it is derived from the DSSE envelope for backward compatibility. |
| `dsse_envelope` | `{ payloadType, payload, signatures[] }` | no | DSSE/in-toto envelope attached when the record is emitted with `useDsse: true`; present on `aep/v0.4` records (v0.4) |

---

## `ActionEvidence` fields

| Field | Type | Required | Description |
|---|---|---|---|
| `action_id` | `string` | **yes** | Unique ID for this action |
| `tool_name` | `string` | **yes** | Name of the tool called |
| `state_changing` | `boolean` | **yes** | Whether this tool modifies external state |
| `timestamp_ms` | `number` | **yes** | Unix epoch ms when the action was taken |
| `recording_mode` | `"validation" \| "delta" \| "full"` | **yes (v0.3)** | Evidence capture depth; emitter defaults to `"validation"` |
| `side_effect_class` | `"read" \| "mutate-local" \| "mutate-external" \| "network-egress" \| "unknown"` | **yes (v0.3)** | Side-effect classification; emitter defaults to `"unknown"` |
| `precondition_digest` | `string` | no | sha256 of relevant state before the call |
| `result_digest` | `string` | no | sha256 of the tool's return value |
| `evidence_refs` | `string[]` | no | URIs to additional evidence artifacts |
| `capability_decision` | `CapabilityDecision` | no | The policy decision for this specific call |
| `argument_drift` | `ArgumentDrift` | no | Detected drift between approved and observed arguments (v0.3) |

---

## `CapabilityDecision` fields

| Field | Type | Required | Description |
|---|---|---|---|
| `capability` | `string` | **yes** | Capability name (typically tool name) |
| `subject` | `string` | **yes** | Who is requesting (e.g. `"agent"`) |
| `resource` | `string` | **yes** | What is being accessed |
| `decision` | `"allow" \| "deny" \| "ask_user" \| "dry_run"` | **yes** | Policy outcome |
| `reason_code` | `string` | no | Machine-readable reason (e.g. `"DENY_BLOCKED"`) |
| `approval_mode` | `"one-shot-payload" \| "bounded-lease" \| "policy-allow-with-receipt" \| "policy-deny-with-evidence" \| "re-approval-on-drift" \| "none"` | **yes (v0.3, default `"none"`)** | How the approval decision was reached (v0.3) |
| `approval_extension` | `ApprovalExtension` | no | Namespace-scoped extension evidence for the approval (v0.3) |
| `deny_reason_class` | `"tool-identity" \| "argument" \| "tainted-input" \| "resource-scope" \| "missing-delegation" \| "policy-rule" \| "other"` | no | Reason category for a deny decision (v0.3) |

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
| Add new required field | Requires `aep/v0.4` + migration script in `evomerge` |
| Remove any field | Requires `aep/v0.4` + deprecation period (min. 2 weeks) |
| Change enum values | Requires `aep/v0.4` |
| Change field type | Requires `aep/v0.4` |

---

## Example `AEPRecord`

```json
{
  "schema_version": "aep/v0.3",
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
      "recording_mode": "validation",
      "side_effect_class": "read",
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
  "run_side_effect_class_max": "read",
  "created_at_ms": 1750950001234,
  "signature": {
    "alg": "ed25519",
    "key_id": "local-dev-key-01",
    "sig": "<base64-encoded Ed25519 signature>"
  }
}
```

When the emitter is configured with `useDsse: true`, the emitted `aep/v0.4` record additionally carries a `dsse_envelope` and a `schema_version` of `"aep/v0.4"`.

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
- **in-toto/DSSE wrapping** -- since AEP v0.4, `AEPEmitter` with `useDsse: true` emits records as predicates inside DSSE/in-toto attestation envelopes (`dsse_envelope`), enabling supply-chain verification.

AgentHook v0.2 offers `decision.confidence` scoring and `observation.trust_level` enums that AEP does not yet provide; these are candidates for a future AEP version after v0.4.

---

## Related

- [`@wasmagent/aep` package](../packages/aep/README.md) — `AEPEmitter`, `AEPRecord`, `BudgetLedger` TypeScript types
- [Trust Pack 30-min quickstart](./quickstarts/trust-pack-30min.md) — end-to-end usage
- [trace-pipeline evomerge](https://github.com/WasmAgent/trace-pipeline) — downstream consumer
- [RFC: AEP <-> AgentHook v0.2 Alignment](./rfcs/rfc-aep-agenthook-alignment.md) — field mapping and in-toto wrapping feasibility
