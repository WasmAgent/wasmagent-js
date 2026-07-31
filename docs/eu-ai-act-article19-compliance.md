# EU AI Act Article 19 — AEP Coverage Mapping

**EU AI Act Article 19** ("Automatically generated logs") entered into force **2 August 2026**
and requires operators of high-risk AI systems to ensure those systems automatically generate
logs throughout their lifetime.

This document maps AEP (Agent Evidence Protocol) schema fields to each Article 19 obligation
so that operators can demonstrate compliance using AEP records produced by `@wasmagent/aep`
and forwarded via `@wasmagent/otel-exporter`.

---

## Article 19 obligations and AEP field coverage

| Article 19 requirement | AEP field(s) | Notes |
|---|---|---|
| Automatic logging throughout system lifetime | `created_at_ms`, `run_id` | Every AEP record carries a UTC epoch timestamp and a unique run identifier. Records are emitted automatically per agent invocation. |
| Identity of the AI system | `run_context.agent_id`, `run_context.agent_version` | Identifies the agent instance and version that produced the run. |
| Period of operation (start/end) | `created_at_ms`, `actions[].timestamp_ms` | Run-level timestamp plus per-action timestamps reconstruct exact operation periods. |
| Data used to train the system | `repo_commit`, `run_context.dependency_lock_digest` | Locks code and dependency state at run time. |
| Verification data for monitoring | `verifier_results[]` | Per-run verifier pass/fail records with `verifier_id`, `passed`, `score`. |
| Input data and source | `input_refs[].uri`, `input_refs[].digest`, `input_refs[].taint_labels` | Content-addressable input references with optional taint provenance. |
| Output data and effects | `output_refs[].uri`, `output_refs[].digest`, `output_refs[].redaction_profile` | Content-addressable output references with redaction metadata. |
| Decisions made by the system | `actions[].tool_name`, `actions[].state_changing`, `capability_decisions[]` | Per-action records with capability allow/deny/ask_user/dry_run decisions. |
| Decision rationale | `actions[].input_taint_labels`, `actions[].output_taint_labels`, `argument_drift` | Taint propagation and argument-drift detection provide decision context. |
| Interactions with persons | `user_id`, `run_context.delegation_chain` | Optional user identity and delegation chain for human-in-the-loop interactions. |
| Side-effect scope | `side_effect_class`, `run_side_effect_class_max` | Classifies each run as `read` / `mutate-local` / `mutate-external` / `network-egress`. |
| Tamper-evidence | `signature.alg`, `signature.key_id`, `signature.sig` | Optional Ed25519 / DSSE signature over the record. `recording_mode: full` captures all fields; `recording_mode: delta` captures changes only. |

---

## Recording modes and Article 19 fidelity

| `recording_mode` | Article 19 fidelity | Recommended use |
|---|---|---|
| `full` | Complete — all fields captured | Regulated deployments, audit-grade retention |
| `delta` | Partial — only changed fields | Low-overhead production monitoring |
| `validation` | Minimal — verifier results only | CI/testing; not sufficient for Article 19 alone |

Operators subject to Article 19 should use `recording_mode: full` or retain the combination
of `delta` records alongside a baseline snapshot that together cover all required fields.

---

## Retention

Article 19 requires logs to be retained for at least the operational lifetime of the AI system,
or as required by applicable sector regulation (e.g. GDPR deletion obligations, financial
services retention rules).

`trace-pipeline` Milestone 5 adds a time-partitioned archival layer (`Fix #53`) that supports
configurable retention windows. Operators can configure the archival layer to satisfy their
specific retention obligations without changing the AEP record schema.

---

## Completeness check (self-assessment)

Run the following to verify that a set of AEP records covers all Article 19 required fields:

```ts
import { validateAepRecord } from '@wasmagent/compliance'

// Required fields for Article 19 full coverage
const ARTICLE_19_REQUIRED = [
  'run_id', 'created_at_ms', 'run_context.agent_id',
  'run_context.agent_version', 'input_refs', 'output_refs',
  'actions', 'capability_decisions', 'recording_mode',
]

function checkArticle19Coverage(record: unknown): string[] {
  const missing: string[] = []
  for (const field of ARTICLE_19_REQUIRED) {
    const parts = field.split('.')
    let cur: unknown = record
    for (const part of parts) {
      cur = (cur as Record<string, unknown>)?.[part]
    }
    if (cur === undefined || cur === null) missing.push(field)
  }
  return missing
}
```

---

## References

- [EU AI Act Article 19 — full text](https://artificialintelligenceact.eu/article/19/)
- [AEP record schema (canonical)](https://github.com/WasmAgent/wasmagent-protocol/tree/main/schemas/aep)
- [trace-pipeline Milestone 5 archival layer](https://github.com/WasmAgent/trace-pipeline)
- [AEP OpenTelemetry exporter](https://www.npmjs.com/package/@wasmagent/otel-exporter)
