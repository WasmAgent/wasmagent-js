---
"@wasmagent/core": minor
---

**TelemetryPolicy primitives — configurable retention, redaction, and export (#389)**

New `@wasmagent/core/experimental` exports providing the policy layer for operational telemetry and evidence:

- `applyRetention(kv, policy)` — age- and count-based KV sweeps scoped to a key prefix (e.g. `evlog:` event logs, `obs:` observations), with a pluggable timestamp extractor that understands `timestampMs` / `createdAtMs` shapes.
- `redactText` / `redactValue` — rule-based redaction (regex or literal, custom replacement) for strings and nested JSON-ish payloads before persistence or export.
- `BatchingExporter` — non-blocking batch-then-flush sink plumbing for export pipelines.

Deliberately dependency-free and side-effect-free: callers wire the primitives into the surface they own (EventLog, EvidenceStore, OTel exporters). Exposed under `experimental` pending real-world hardening.
