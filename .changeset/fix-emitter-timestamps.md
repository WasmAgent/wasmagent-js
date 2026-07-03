---
"@wasmagent/aep": patch
---

fix(aep): use Date.now() instead of performance.now() for default timestamps

- `emit()` / `build()` now defaults `created_at_ms` to `Date.now()` (Unix epoch ms) instead of `performance.now()` (ms since process start). Fixes records showing `1970-01-01` in downstream audit tools.
- `addAction()` without explicit `timestamp_ms` also defaults to `Date.now()`.
- `addAction()` with `capability_decision` now auto-registers to `capability_decisions[]` (deduped), fixing silent empty manifest in downstream `toEvents()`.

Fixes: #14, #15
