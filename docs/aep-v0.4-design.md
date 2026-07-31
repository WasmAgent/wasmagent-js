# AEP v0.4 Design Notes

This document records the design rationale for AEP (Agent Evidence Protocol) v0.4 —
the decisions made, the tradeoffs considered, and the invariants future maintainers
must preserve.

Canonical schema: [`wasmagent-protocol/schemas/aep/`](https://github.com/WasmAgent/wasmagent-protocol/tree/main/schemas/aep)

---

## Why DSSE/in-toto envelope over HMAC-only

Earlier AEP versions used a simple HMAC over the serialised record. This was replaced
with a [DSSE (Dead Simple Signing Envelope)](https://github.com/secure-systems-lab/dsse)
/ in-toto attestation envelope for three reasons:

1. **Key rotation without record invalidation.** HMAC ties verification to a shared
   secret. DSSE uses asymmetric keys: old records stay verifiable with the old public
   key even after the signing key rotates. This matters for long-lived audit logs.

2. **Cross-system verification.** DSSE envelopes are self-describing (`payloadType`,
   `signatures[].keyid`). A third-party auditor (e.g. a compliance tool, a court-ordered
   forensic review) can verify the signature without access to internal HMAC secrets.

3. **in-toto ecosystem compatibility.** The in-toto `agent-decision` predicate
   (tracked in [in-toto/attestation#554](https://github.com/in-toto/attestation/issues/554))
   uses DSSE as its envelope. AEP adopting the same envelope means AEP records can be
   ingested by in-toto-aware supply chain tools without a conversion layer.

**Invariant:** The `signature` field in `aep-record.schema.json` is deliberately
**optional** in v0.3/v0.4. Tightening it to `required` is a breaking change that
needs an org RFC (see `CONTRACT-CHANGE-PROCESS.md` section 3). Do not silently add
it to the `required` array.

---

## `recording_mode` semantics and privacy tradeoffs

`recording_mode` controls how much of the run state is captured in the evidence record.

| Value | What is captured | Privacy exposure | Article 19 sufficient? |
|---|---|---|---|
| `full` | All fields, all actions, all refs | Highest | Yes |
| `delta` | Only fields that changed from the previous record in the session | Medium | Only with baseline snapshot |
| `validation` | `verifier_results` only — no input/output refs, no actions | Minimal | No |

**Why not `summary` or `redacted`?** Earlier drafts used those names. They were rejected
because they imply post-processing (redaction is an active operation, not a capture mode).
`delta` and `validation` describe *what was captured at collection time*, not what was
removed afterwards. Redaction of already-captured records is handled via
`output_refs[].redaction_profile`, which is separate.

**Privacy guidance:** Operators processing personal data should use `recording_mode: delta`
combined with field-level redaction profiles on `output_refs` rather than `full` with
broad log suppression. This preserves audit fidelity while minimising personal data
retention — consistent with GDPR data minimisation (Article 5(1)(c)).

---

## `taint_labels` / `output_taint_labels` propagation rules

Taint labels mark data that crossed a trust boundary (tool result, memory retrieval,
inter-agent message) and must not be acted upon without explicit policy approval.

**On `input_refs[].taint_labels`:** Labels applied to the *inputs* to the run. Set by
the caller when handing off data from a prior untrusted source. Example: `["user-supplied",
"mcp-tool-result"]`.

**On `actions[].input_taint_labels`:** Labels propagated forward from the run's
`input_refs` to the specific action that consumed those inputs. The enforcement layer
(capability manifest policy) gates on these labels before executing state-changing actions.

**On `actions[].output_taint_labels`:** Labels applied to the *outputs* of an action.
An action that calls an external MCP tool marks its result `["mcp-tool-result"]`.
Downstream actions that consume this result inherit the label.

**Propagation rule:** Taint is *additive* — labels are unioned, never cleared. Only an
explicit policy approval (`capability_decisions[].decision = "allow"` with a matching
`reason_code`) records that a tainted value was deliberately acted upon. This creates
an auditable consent record.

---

## Relationship to in-toto `agent-decision` predicate

The in-toto `agent-decision/v0.1` predicate (CNCF, draft) covers:
- The agent's goal and selected action
- The capability scope active at decision time
- A cryptographic binding to the tool descriptor

AEP v0.4 is a superset: it adds budget ledger, taint propagation, multi-step action
chains, verifier results, and side-effect classification. The overlap fields
(`actions[].tool_name`, `actions[].tool_descriptor_digest`, `capability_decisions`)
are intentionally compatible so AEP records can be projected down to the in-toto
predicate for cross-tool interoperability.

---

## `side_effect_class` vocabulary

Introduced in aep/v0.3 to give the enforcement layer a single classification axis
across both per-action and per-run scope:

| Value | Meaning |
|---|---|
| `read` | No state mutation; safe to replay |
| `mutate-local` | Mutates local state (filesystem, DB) but no external side effects |
| `mutate-external` | Mutates external state (third-party API, shared service) |
| `network-egress` | Sends data outside the trust boundary |
| `unknown` | Not yet classified; enforcement layer should treat as `network-egress` |

`run_side_effect_class_max` records the *highest* class observed across the whole run,
using the ordering above (read < mutate-local < mutate-external < network-egress).
This allows a single-field policy gate: "deny any run where `run_side_effect_class_max`
= `network-egress` unless the destination is allowlisted."

---

## `argument_drift` detection

`argument_drift` records a detected mismatch between an action's declared arguments
(as specified in the tool manifest at session start) and the arguments used at runtime.
This surfaces rug-pull attacks (tool behaviour changed post-approval) and semantic
drift under LLM parameter variation.

Fields: `tool_name`, `declared_digest` (hash of expected args), `actual_digest` (hash
of runtime args), `diff_summary` (human-readable), `drifted_args` (list of argument names).

An empty `argument_drift` object means no drift was detected. Absence of the field means
drift detection was not run (e.g. `recording_mode: validation`).
