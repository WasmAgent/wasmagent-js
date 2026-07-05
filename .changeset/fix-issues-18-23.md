---
"@wasmagent/aep": minor
---

feat(aep): resolve issues #18-#23

- Export `isStateChangingTool()` and `STATE_CHANGING_PATTERNS` from new utils module (#23)
- Add `session_id` and `turn_index` fields to RunContext for multi-turn audit trails (#22)
- PermissionGate schema for system permission layer signaling (#21)
- `user_id` and `subject_id` on AEPRecord for cross-run behavior audit (#20)
- `created_at_ms` in AEPEmitterOptions for ergonomic timestamp seeding (#19)
- Regenerated JSON Schema with all new fields; added Python emitter example (#18)
