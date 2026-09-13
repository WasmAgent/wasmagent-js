---
"@wasmagent/aep": patch
---

Regenerate the JSON Schema export from the Zod source of truth. The exported `schemas/aep-record.schema.json` now includes run-level `recording_mode`, `side_effect_class`, and `argument_drift` (open object) matching the canonical protocol schema, plus `uniqueItems: true` on `run_attribution_backing_observed`. The export script post-processes uniqueness refinements, which zod-to-json-schema cannot express; CI's `schema:check` verifies freshness against this exact pipeline.
