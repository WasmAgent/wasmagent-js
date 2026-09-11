---
"@wasmagent/aep": patch
---

Regenerate the exported AEP JSON Schema from the current runtime model, and keep it fresh in CI. The shipped `schemas/aep-record.schema.json` had drifted to aep/v0.3 while `AEPEmitter` already produced aep/v0.4 records (DSSE envelope included); it is now regenerated from `AEPRecordSchema`, and a new `schema:check` script (wired into CI) fails when the export goes stale again.
