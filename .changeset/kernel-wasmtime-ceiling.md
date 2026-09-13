---
"@wasmagent/kernel-wasmtime": patch
---

The constructor `capabilities` manifest is now stored as a frozen immutable authority ceiling: every `run()` merges it restrictively with the per-call manifest (`resolveEffectiveCapabilities`), so a per-call manifest may narrow but never widen the constructor grant.
