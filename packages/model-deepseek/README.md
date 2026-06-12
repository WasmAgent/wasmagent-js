# @agentkit-js/model-deepseek

DeepSeek V4 adapter — `thinking: { type, effort }` + auto-prefix prompt cache.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

> ▽ **Maintenance-mode.** This adapter is functional and security-patched, but is **not** receiving proactive feature work — it is dominated by `GenericOpenAICompatModel` + a recipe in [`docs/guides/openai-compat-recipes.md`](https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/openai-compat-recipes.md). See [maintenance tiers](https://github.com/telleroutlook/agentkit-js/blob/main/docs/strategy/maintenance-tiers.md) for the rationale. If you actively use this package and want it promoted to ◆ Narrative, open an issue tagged `tier:promote-request` with your use case.

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
