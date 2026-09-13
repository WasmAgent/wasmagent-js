---
"@wasmagent/aep": patch
---

Align the exported `aep-record.schema.json` with the canonical protocol schema: adopt run-level `argument_drift`, `recording_mode`, and `side_effect_class` definitions verbatim, and add `uniqueItems: true` to `run_attribution_backing_observed`. This resolves all remaining Gate B `reconcile` drifts; per-action `argument_drift` remains a documented JS extension. No runtime behavior change.
