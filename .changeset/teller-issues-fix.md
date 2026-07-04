---
"@wasmagent/aep": minor
---

feat(aep): add JSON Schema export, timestamp override in addAction, user_id/subject_id fields, and permission_gate signal

- #18: Export AEP schema as JSON Schema for non-TS consumers + Python emitter example
- #19: addAction accepts optional timestamp_ms for historical data seeding
- #20: AEPRecord gains optional user_id and subject_id for cross-run audit
- #21: Actions can carry permission_gate to signal platform-level authorization
