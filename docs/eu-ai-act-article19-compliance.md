# EU AI Act Article 19 — Automatic Logging: AEP Coverage Mapping

> **Status:** Compliant as of AEP v0.3 with `recording_mode: full`
> **Effective date:** 2 August 2026
> **Applies to:** High-risk AI systems under EU AI Act Annex III

## Article 19 Requirements

Article 19 requires high-risk AI systems to automatically log:

1. **System operation throughout its lifetime** — continuous logging, not sampling
2. **Enabling monitoring after deployment** — logs must be machine-readable and auditable
3. **Minimum retention: lifetime of the system**, or as required by applicable law

## AEP v0.3 Field Mapping

| Article 19 Requirement | AEP Field | Notes |
|---|---|---|
| **Timestamp / temporal ordering** | `actions[].timestamp_ms` | Unix epoch ms per action; `created_at_ms` for record creation |
| **Agent identity** | `run_context.agent_id`, `run_context.agent_version`, `run_context.subagent_id` | Includes delegation chain via `run_context.delegation_chain` |
| **Action type / tool invoked** | `actions[].tool_name`, `actions[].side_effect_class` | Classifies read / mutate-local / mutate-external / network-egress |
| **Inputs** | `input_refs[].uri`, `input_refs[].digest`, `actions[].arguments_digest` | Content-addressed; taint labels via `input_refs[].taint_labels` |
| **Outputs** | `output_refs[].uri`, `output_refs[].digest`, `actions[].result_digest` | Redaction profile supported via `output_refs[].redaction_profile` |
| **Session / run identifier** | `run_id`, `run_context.session_id`, `trace_id` | Parent trace linkable via `parent_trace_id` |
| **Model identity** | `model_provider`, `model_id` | Provider + model ID logged at record level |
| **Policy / capability decisions** | `capability_decisions[]`, `actions[].capability_decision`, `actions[].permission_gate` | Decision (allow/deny/ask_user), reason code, approval mode |
| **Pre/post state** | `actions[].pre_state_digest`, `actions[].post_state_digest` | State digest kind: git-tree, sandbox-fs, db-rowset, etc. |
| **Verifier results** | `verifier_results[]` | Compliance check outcomes with scores |
| **Immutability / tamper evidence** | `signature` (ed25519), `policy_bundle_digest`, `tool_manifest_digest` | DSSE envelope; key_id identifies signing key |

## recording_mode: full

When `actions[].recording_mode` is set to `"full"`:

- All mandatory Article 19 fields are captured
- `precondition_digest` and `result_digest` are populated
- `pre_state_digest` / `post_state_digest` provide before/after system state
- `argument_drift` detection records any deviation from approved arguments

`"validation"` mode (default) captures only the minimum required for policy enforcement and **does not satisfy Article 19 lifetime logging obligations** for high-risk systems.

## Retention

Article 19 requires logs to be retained for the lifetime of the system or as required by applicable law. AEP records are content-addressed and signed — retention is an infrastructure concern (storage backend). See [Milestone 5 in trace-pipeline](https://github.com/WasmAgent/trace-pipeline) for the archival layer.

The AEP schema itself does not impose a retention limit. Operators deploying high-risk AI systems must configure their storage backend to retain AEP records for the required period.

## Gaps / Open Items

- [ ] `schema_version` field still enumerates `aep/v0.1–v0.3`; update to include `aep/v0.4` once schema version is bumped
- [ ] `recording_mode: full` should be enforced by policy for high-risk deployments — currently opt-in
- [ ] Lifetime retention implementation is in trace-pipeline Milestone 5 (pending)
