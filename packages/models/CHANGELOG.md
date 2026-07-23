# @wasmagent/models

## 2.0.0

### Major Changes

- e74c032: Extract model adapters into `@wasmagent/models` (closes #123)

  **Breaking:** `AnthropicModel`, `OpenAIModel`, `OpenAICompatModel`, `GenericOpenAICompatModel`, `FallbackModel`, and `RetryPolicy` are no longer exported from `@wasmagent/core` or `@wasmagent/core/models`.

  Migrate your imports:

  ```ts
  // Before
  import { AnthropicModel, FallbackModel } from "@wasmagent/core";
  import { OpenAICompatModel } from "@wasmagent/core/models";

  // After
  import {
    AnthropicModel,
    FallbackModel,
    OpenAICompatModel,
  } from "@wasmagent/models";
  // Or use subpaths for tree-shaking:
  import { AnthropicModel } from "@wasmagent/models/anthropic";
  import { DeepSeekModel } from "@wasmagent/models/deepseek";
  ```

  `@wasmagent/core/models` now exports only the stable contracts (`Model`, `ModelMessage`, `GenerateOptions`, `StreamEvent`, `ModelCapabilities`, `ModelRegistry`, `TokenBudget`, `repairJson`, and related types). The volatile provider adapters live in `@wasmagent/models` so that provider-SDK churn no longer forces a `@wasmagent/core` release that ripples to all 40+ downstream packages.

  The `model-*` packages (`@wasmagent/model-anthropic`, `@wasmagent/model-openai`, etc.) are now thin re-export shims pointing at `@wasmagent/models`. They remain published for backwards compatibility but are deprecated — migrate directly to `@wasmagent/models`.

  `@wasmagent/model-local` is unchanged (standalone native peer dependency).

### Patch Changes

- Updated dependencies [e74c032]
  - @wasmagent/core@3.0.0

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
