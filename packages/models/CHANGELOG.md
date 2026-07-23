# @wasmagent/models

## 1.1.2

### Patch Changes

- Updated dependencies [6a62876]
  - @wasmagent/core@2.0.0
  - @wasmagent/model-anthropic@1.0.6
  - @wasmagent/model-deepseek@1.0.6
  - @wasmagent/model-doubao@1.0.6
  - @wasmagent/model-minimax@1.0.6
  - @wasmagent/model-moonshot@1.0.6
  - @wasmagent/model-openai@1.0.6
  - @wasmagent/model-qwen@1.0.6
  - @wasmagent/model-zhipu@1.0.6

## 1.1.1

### Patch Changes

- Updated dependencies [27571bf]
  - @wasmagent/core@1.21.0
  - @wasmagent/model-anthropic@1.0.5
  - @wasmagent/model-deepseek@1.0.5
  - @wasmagent/model-doubao@1.0.5
  - @wasmagent/model-minimax@1.0.5
  - @wasmagent/model-moonshot@1.0.5
  - @wasmagent/model-openai@1.0.5
  - @wasmagent/model-qwen@1.0.5
  - @wasmagent/model-zhipu@1.0.5

## 1.1.0

### Minor Changes

- 9df44c1: chore: repo hygiene — dependency cleanup, changeset decoupling, models consolidation

  - #120: Remove unused root-level `@noble/ed25519` production dependency (belongs in @wasmagent/aep)
  - #121: Convert all internal @wasmagent/_ dependency ranges to `workspace:_` for consistent monorepo resolution
  - #122: Remove `linked` and set `updateInternalDependencies: "none"` in changeset config to decouple release cascade (version coherence is enforced by check-version-coherence.mjs)
  - #123: Create `@wasmagent/models` consolidated re-export package for all model adapters (except model-local which has native deps)
  - #124: Fold `@wasmagent/agent-prompts` into `@wasmagent/core/prompts` subpath export; agent-prompts package kept as deprecated backward-compat shim

### Patch Changes

- Updated dependencies [6553c88]
- Updated dependencies [1692c19]
- Updated dependencies [9df44c1]
  - @wasmagent/core@1.20.0
  - @wasmagent/model-anthropic@1.0.4
  - @wasmagent/model-deepseek@1.0.4
  - @wasmagent/model-doubao@1.0.4
  - @wasmagent/model-minimax@1.0.4
  - @wasmagent/model-moonshot@1.0.4
  - @wasmagent/model-openai@1.0.4
  - @wasmagent/model-qwen@1.0.4
  - @wasmagent/model-zhipu@1.0.4
