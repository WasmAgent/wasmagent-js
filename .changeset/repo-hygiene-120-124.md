---
"@wasmagent/core": patch
"@wasmagent/models": minor
---

chore: repo hygiene — dependency cleanup, changeset decoupling, models consolidation

- #120: Remove unused root-level `@noble/ed25519` production dependency (belongs in @wasmagent/aep)
- #121: Convert all internal @wasmagent/* dependency ranges to `workspace:*` for consistent monorepo resolution
- #122: Remove `linked` and set `updateInternalDependencies: "none"` in changeset config to decouple release cascade (version coherence is enforced by check-version-coherence.mjs)
- #123: Create `@wasmagent/models` consolidated re-export package for all model adapters (except model-local which has native deps)
- #124: Fold `@wasmagent/agent-prompts` into `@wasmagent/core/prompts` subpath export; agent-prompts package kept as deprecated backward-compat shim
