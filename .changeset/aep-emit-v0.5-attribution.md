---
"@wasmagent/aep": minor
---

Emit the aep/v0.5 attribution-grading vocabulary. `AEPEmitterOptions` gains `schemaVersion` (`"aep/v0.3"` default — unchanged behaviour — `"aep/v0.4"`, `"aep/v0.5"`) and six optional attribution fields: `authorized_by`, `authority_origin`, `identity_source`, `attribution_backing`, `run_attribution_backing_floor` (the weakest grade present, MUST NOT round up) and `run_attribution_backing_observed`. With `useDsse: true` the DSSE path stamps `aep/v0.4` unless `schemaVersion` is explicitly `"aep/v0.5"`. The exported JSON Schema (`schemas/aep-record.schema.json`) is regenerated to match; canonical vocabulary per `WasmAgent/wasmagent-protocol` 0.1.9 (aep/v0.5) and the OWASP Verifiable Authorization Lineage recommended control.
