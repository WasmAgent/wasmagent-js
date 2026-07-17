# RFC: AEP <-> AgentHook v0.2 Field Alignment and in-toto Attestation Wrapping

- **Status:** Draft
- **Authors:** WasmAgent Core Team
- **Created:** 2026-07-16
- **Related issues:** #41

---

## Motivation

As agent-based systems mature, multiple evidence and observability standards are emerging in parallel. The Agent Evidence Protocol (AEP) used by WasmAgent provides deep capability-decision and budget-tracking evidence, while the AgentHook v0.2 draft proposes a lighter-weight event model for agent runtime evidence.

Alignment between these two schemas matters for three reasons:

1. **Downstream compliance tooling** -- Organizations adopting EU AI Act Article 12 logging requirements need a single evidence pipeline that can ingest records from different agent frameworks. A clear mapping enables bridge adapters without data loss.

2. **Interoperability** -- Multi-agent systems increasingly combine heterogeneous runtimes (e.g., a WasmAgent orchestrator delegating to an AgentHook-instrumented sub-agent). A field alignment table lets integrators translate records at pipeline boundaries.

3. **Supply-chain attestation** -- Both schemas can benefit from wrapping evidence inside in-toto/DSSE envelopes. Understanding the structural overlap is a prerequisite for designing a shared predicateType that maximizes reuse across ecosystems.

---

## Field-by-field Comparison Table

### Top-level Record Fields

| AEP Field | AgentHook v0.2 Equivalent | Notes |
|---|---|---|
| `schema_version` | (implicit in `event_type` versioning) | AEP uses an explicit literal enum; AgentHook relies on event_type strings carrying version semantics. |
| `run_id` | `session_id` | Both identify a logical execution scope. AEP's `run_id` is per-invocation; AgentHook's `session_id` may span multiple events. |
| `user_id` | (no direct equivalent) | AEP tracks the human principal; AgentHook does not model user identity at the event level. |
| `subject_id` | `agent_id` | Both identify the acting agent entity. |
| `trace_id` | `event_id` | AEP's `trace_id` is OpenTelemetry-compatible and spans the full run; AgentHook's `event_id` is per-event. The correlation model differs. |
| `parent_trace_id` | `parent_event_id` | Both establish causal/hierarchical links. AEP links runs; AgentHook links events within a session. |
| `repo_commit` | (no equivalent) | AEP captures code provenance; AgentHook does not model source versioning. |
| `runtime_version` | (no equivalent) | AEP records the agent framework version. |
| `model_provider` | `model_call.provider` | Direct mapping. |
| `model_id` | `model_call.model` | Direct mapping. |
| `policy_bundle_digest` | (no equivalent) | AEP-only: ties the run to a specific policy configuration. |
| `tool_manifest_digest` | (no equivalent) | AEP-only: integrity anchor for the set of available tools. |
| `mcp_server_card_digest` | (no equivalent) | AEP-only: MCP server identity digest. |
| `input_refs` | (no direct equivalent; closest: `model_call.messages`) | AEP uses content-addressed digests; AgentHook stores raw message payloads. |
| `output_refs` | (no direct equivalent; closest: `model_call.completion`) | Same distinction as `input_refs`. |
| `capability_decisions` | `decision` (per-event) | AEP stores an array of structured decisions per run; AgentHook models decisions as individual events with type/reasoning/confidence. |
| `actions` | `action` (per-event) | AEP bundles all actions in a single record; AgentHook emits one event per action. |
| `verifier_results` | (no equivalent) | AEP-only: post-run verification verdicts. |
| `budget_ledger` | (no equivalent) | AEP-only: resource consumption accounting. |
| `created_at_ms` | `timestamp` | Direct mapping (AEP uses epoch ms; AgentHook uses ISO 8601 or epoch). |
| `run_context` | Partial: `agent_id`, `session_id` | AEP's `run_context` includes delegation_chain, environment_digest, dependency_lock_digest, session_id, turn_index -- richer than AgentHook's flat fields. |
| `run_side_effect_class_max` | (no equivalent) | AEP v0.3 run-level side-effect ceiling. |
| `signature` | `attestation` | AEP uses Ed25519 over canonical record bytes; AgentHook's `attestation` supports multiple methods (method, signer, timestamp_proof). |
| `prev_record_hash` | (no equivalent) | AEP chain-linking for tamper-evidence (introduced in A1). |

### Action-level Fields

| AEP `ActionEvidence` Field | AgentHook v0.2 Equivalent | Notes |
|---|---|---|
| `action_id` | (implicit in `event_id`) | AgentHook's event_id serves as the action identifier. |
| `tool_name` | `tool_name` / `action.type` | Direct mapping. |
| `state_changing` | (no equivalent) | AEP explicitly flags mutation; AgentHook does not classify actions by side-effect. |
| `precondition_digest` | (no equivalent) | AEP captures pre-state for reproducibility. |
| `result_digest` | (no equivalent; `tool_output` carries raw value) | AEP digests results; AgentHook stores them in full. |
| `evidence_refs` | (no equivalent) | AEP links to external evidence artifacts. |
| `capability_decision` | `decision` | Partial overlap; AgentHook lacks AEP's structured allow/deny/ask_user/dry_run enum and approval_mode. |
| `timestamp_ms` | `timestamp` | Direct mapping. |
| `parent_action_id` | `parent_event_id` | Causal chain link. |
| `side_effect_class` | (no equivalent) | AEP v0.3 classification (read/mutate-local/mutate-external/network-egress/unknown). |
| `permission_gate` | (no equivalent) | AEP signals that platform-level authorization was exercised. |
| `argument_drift` | (no equivalent) | AEP v0.3 drift detection between approved and observed arguments. |
| `recording_mode` | (no equivalent) | AEP v0.3 controls evidence capture depth. |
| `input_taint_labels` / `output_taint_labels` | (no equivalent) | AEP taint propagation tracking. |

---

## AEP-only Fields (No AgentHook Equivalent)

These fields represent capabilities unique to AEP's evidence model:

| Field | Purpose |
|---|---|
| `policy_bundle_digest` | Binds the run to a specific, content-addressed policy configuration. |
| `tool_manifest_digest` | Integrity hash of the tool set available during the run. |
| `mcp_server_card_digest` | Identity anchor for the MCP server providing tools. |
| `verifier_results` | Post-run verification verdicts with pass/fail, score, and claim linkage. |
| `budget_ledger` | Multi-dimensional resource accounting (tokens, latency, tools, risk, retries, human approvals). |
| `prev_record_hash` | Hash-chain linking for tamper-evident record sequences. |
| `run_side_effect_class_max` | Declares the maximum side-effect class observed across the entire run. |
| `run_context.delegation_chain` | Ordered list of agent delegation hops. |
| `run_context.environment_digest` | Content hash of the execution environment. |
| `run_context.dependency_lock_digest` | Lock-file integrity for reproducibility. |
| `ActionEvidence.side_effect_class` | Per-action side-effect classification. |
| `ActionEvidence.permission_gate` | Platform authorization signal. |
| `ActionEvidence.argument_drift` | Drift detection between approved and observed tool arguments. |
| `ActionEvidence.recording_mode` | Evidence capture depth control (validation/delta/full). |
| `ActionEvidence.input_taint_labels` / `output_taint_labels` | Information-flow taint propagation. |
| `ActionEvidence.pre_state_digest` / `post_state_digest` | Before/after state snapshots for reproducibility. |
| `CapabilityDecision.approval_mode` | Structured approval semantics (one-shot, bounded-lease, etc.). |
| `CapabilityDecision.deny_reason_class` | Categorized denial reasons. |

---

## AgentHook-only Fields (No AEP Equivalent)

These fields represent capabilities unique to AgentHook v0.2's event model:

| Field | Purpose | Potential AEP Adoption |
|---|---|---|
| `decision.confidence` | Numeric confidence score for agent decisions. | Could be added to `CapabilityDecision` as an optional field. |
| `decision.reasoning` | Free-text explanation of why a decision was made. | AEP has `reason_code` (machine-readable); could add a human-readable complement. |
| `observation.source` | Identifies where an observation originated. | AEP uses `input_refs` with URIs, but lacks a dedicated observation event type. |
| `observation.content` | Raw observation payload. | AEP digests content rather than storing it (by design for privacy). |
| `observation.trust_level` | Enum classifying trust in an observation source. | Novel concept; could inform AEP's taint labels or a new trust annotation. |
| `attestation.timestamp_proof` | External timestamp authority proof (e.g., RFC 3161). | AEP could adopt this alongside its Ed25519 signature for non-repudiation. |
| `attestation.method` | Flexible attestation method selection. | AEP currently hardcodes Ed25519; extensible method field is a useful pattern. |
| `model_call.messages` | Full message history for an LLM call. | AEP stores `input_refs` digests; full content available only in `recording_mode: "full"`. |
| `model_call.completion` | Full model response. | Same as above -- AEP digests outputs by default. |

---

## in-toto Attestation Wrapping Feasibility

### Background

[in-toto](https://in-toto.io/) is a supply-chain security framework. Its [DSSE (Dead Simple Signing Envelope)](https://github.com/secure-systems-lab/dsse) format wraps arbitrary attestation predicates with cryptographic signatures. [SLSA](https://slsa.dev/) builds on in-toto for build provenance.

### Proposed Mapping

An AEP record can serve as a **predicate** inside a DSSE envelope:

```json
{
  "payloadType": "application/vnd.in-toto+json",
  "payload": "<base64 of Statement>",
  "signatures": [
    {
      "keyid": "<AEP key_id>",
      "sig": "<DSSE signature over payload>"
    }
  ]
}
```

Where the **Statement** is:

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [
    {
      "name": "wasmagent-agent-binary",
      "digest": {
        "sha256": "<agent binary or container image digest>"
      }
    }
  ],
  "predicateType": "https://wasmagent.dev/aep/v0.3",
  "predicate": {
    // The full AEP record minus the `signature` field
    // (signature is now at the DSSE envelope level)
    "schema_version": "aep/v0.3",
    "run_id": "...",
    "created_at_ms": 1750950001234,
    // ... all other AEP fields
  }
}
```

### Design Decisions

1. **Subject** = the agent binary digest (or container image digest). This anchors "what software produced this evidence" in the supply-chain sense.

2. **predicateType** = `https://wasmagent.dev/aep/v0.3` -- a versioned URI identifying the predicate schema. Consumers can fetch the JSON Schema at this URL.

3. **Predicate** = the AEP record with `signature` removed, since the DSSE envelope provides its own signing layer. The AEP `signature` field becomes redundant when wrapped; however, for standalone transport (outside DSSE), the AEP signature remains authoritative.

4. **Key management** -- The same Ed25519 keypair used by `AEPSigner` can sign the DSSE envelope. For environments requiring multiple signers (e.g., agent + platform co-signature), DSSE's multi-signature support is natively available.

### Feasibility Assessment

| Aspect | Status |
|---|---|
| Schema compatibility | High -- AEP records are self-contained JSON objects; no transformation needed beyond removing `signature`. |
| Signature migration | Medium -- Requires dual-mode: standalone AEP signature for backward compat + DSSE envelope for supply-chain consumers. |
| Tooling support | High -- `in-toto-golang`, `in-toto-python`, and `sigstore/cosign` all support DSSE. A thin TypeScript wrapper is needed. |
| Size constraints | Low risk -- Typical AEP records are 2-10 KB; well within DSSE payload limits. |
| Verification workflow | Straightforward -- `cosign verify-attestation --type https://wasmagent.dev/aep/v0.3` could validate agent evidence in CI. |

---

## Recommendations

1. **Define a canonical `aep-to-agenthook` adapter** -- Implement a bidirectional mapping library (`@wasmagent/aep-bridge`) that converts AEP records to AgentHook v0.2 event streams and vice versa. Prioritize lossless AEP-to-AgentHook for interop; AgentHook-to-AEP will necessarily drop `confidence` and `trust_level` unless AEP adopts them.

2. **Propose `decision.confidence` and `attestation.method` for AEP v0.4** -- These AgentHook fields address real gaps. A `confidence` score on `CapabilityDecision` enables downstream risk scoring, and an extensible `attestation.method` field future-proofs beyond Ed25519.

3. **Implement DSSE wrapping as an optional output mode** -- Add a `--wrap=dsse` flag to the AEP emitter that produces in-toto Statements alongside raw AEP records. This enables supply-chain verification via `cosign` without changing the default record format.

4. **Engage the AgentHook working group on budget and verifier concepts** -- AEP's `budget_ledger` and `verifier_results` address EU AI Act Article 12 requirements for resource monitoring and outcome verification. Proposing these as optional AgentHook extensions would benefit the broader ecosystem.

---

## References

- [AgentHook v0.2 Draft Specification](https://github.com/agenthook/spec) -- Agent runtime evidence event model
- [in-toto Specification v1.0](https://github.com/in-toto/specification) -- Supply-chain attestation framework
- [DSSE: Dead Simple Signing Envelope](https://github.com/secure-systems-lab/dsse/blob/master/envelope.md) -- Envelope format for in-toto attestations
- [SLSA (Supply-chain Levels for Software Artifacts)](https://slsa.dev/spec/v1.0/) -- Build provenance framework built on in-toto
- [EU AI Act, Article 12](https://eur-lex.europa.eu/eli/reg/2024/1689/oj) -- Record-keeping and logging requirements for high-risk AI systems
- [Sigstore cosign](https://docs.sigstore.dev/cosign/overview/) -- Container signing and attestation verification
- [AEP Schema Contract](../aep-contract.md) -- WasmAgent's Agent Evidence Protocol documentation
