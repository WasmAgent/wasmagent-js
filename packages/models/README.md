# @wasmagent/models

Consolidated model adapter barrel for wasmagent.

Re-exports all provider adapters from individual `@wasmagent/model-*` packages
so consumers can import from a single dependency:

```ts
import { AnthropicModel, OpenAIModel, DeepSeekModel } from "@wasmagent/models";
```

Tree-shakeable subpath imports are also available:

```ts
import { DeepSeekModel } from "@wasmagent/models/deepseek";
```

## Included adapters

| Subpath       | Package                    |
|---------------|----------------------------|
| `/anthropic`  | `@wasmagent/model-anthropic` |
| `/openai`     | `@wasmagent/model-openai`    |
| `/deepseek`   | `@wasmagent/model-deepseek`  |
| `/doubao`     | `@wasmagent/model-doubao`    |
| `/minimax`    | `@wasmagent/model-minimax`   |
| `/moonshot`   | `@wasmagent/model-moonshot`  |
| `/qwen`       | `@wasmagent/model-qwen`      |
| `/zhipu`      | `@wasmagent/model-zhipu`     |

## Not included

`@wasmagent/model-local` is excluded because it depends on `node-llama-cpp`
(native bindings). Import it directly when you need local/embedded inference.

## License

Apache-2.0
