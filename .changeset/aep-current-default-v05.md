---
"@wasmagent/aep": minor
---

**Breaking-ish default change (current-truth alignment):** `AEPEmitter` now emits the current schema family `aep/v0.5` by DEFAULT — both unsigned `build()` and DSSE-signed `emit()` stamp `aep/v0.5` when `schemaVersion` is omitted. Previously the defaults were `aep/v0.3` (unsigned) and `aep/v0.4` (signed), producing newly-created legacy records from ordinary usage. Per the org contract ("read legacy, emit current"), `aep/v0.3` / `aep/v0.4` remain available ONLY as an explicit `schemaVersion` opt-in for legacy compatibility; legacy parsing and verification are unchanged. AEP-CURRENT-01..06 tests pin the default path, and default-emitter fixtures now guard cross-language conformance.
