# @agentkit-js/model-deepseek

DeepSeek V4 adapter — `thinking: { type, effort }` + auto-prefix prompt cache.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/model-deepseek @agentkit-js/core
```

## Usage

```ts
import { DeepSeekModel, DeepSeekModels } from "@agentkit-js/model-deepseek";

const model = new DeepSeekModel(DeepSeekModels.V4, {
  apiKey: process.env.DEEPSEEK_API_KEY,
  thinking: { type: "enabled", effort: "high" },
});
```

> ⚠️ **Compliance** — Review the [DeepSeek terms of service](https://platform.deepseek.com/api-docs/) for data handling and regional access requirements.

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
