---
"@wasmagent/core": major
"@wasmagent/aep": patch
"@wasmagent/mcp-firewall": patch
"@wasmagent/compliance": patch
"@wasmagent/models": major
"@wasmagent/model-anthropic": major
"@wasmagent/model-openai": major
"@wasmagent/model-deepseek": major
"@wasmagent/model-doubao": major
"@wasmagent/model-minimax": major
"@wasmagent/model-moonshot": major
"@wasmagent/model-qwen": major
"@wasmagent/model-zhipu": major
---

Extract model adapters into `@wasmagent/models` (closes #123)

**Breaking:** `AnthropicModel`, `OpenAIModel`, `OpenAICompatModel`, `GenericOpenAICompatModel`, `FallbackModel`, and `RetryPolicy` are no longer exported from `@wasmagent/core` or `@wasmagent/core/models`.

Migrate your imports:

```ts
// Before
import { AnthropicModel, FallbackModel } from "@wasmagent/core";
import { OpenAICompatModel } from "@wasmagent/core/models";

// After
import { AnthropicModel, FallbackModel, OpenAICompatModel } from "@wasmagent/models";
// Or use subpaths for tree-shaking:
import { AnthropicModel } from "@wasmagent/models/anthropic";
import { DeepSeekModel } from "@wasmagent/models/deepseek";
```

`@wasmagent/core/models` now exports only the stable contracts (`Model`, `ModelMessage`, `GenerateOptions`, `StreamEvent`, `ModelCapabilities`, `ModelRegistry`, `TokenBudget`, `repairJson`, and related types). The volatile provider adapters live in `@wasmagent/models` so that provider-SDK churn no longer forces a `@wasmagent/core` release that ripples to all 40+ downstream packages.

The `model-*` packages (`@wasmagent/model-anthropic`, `@wasmagent/model-openai`, etc.) are now thin re-export shims pointing at `@wasmagent/models`. They remain published for backwards compatibility but are deprecated — migrate directly to `@wasmagent/models`.

`@wasmagent/model-local` is unchanged (standalone native peer dependency).
