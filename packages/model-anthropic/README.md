# @agentkit-js/model-anthropic

Anthropic Claude adapter — auto prompt-cache breakpoints + 1-hour TTL.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/model-anthropic @agentkit-js/core @anthropic-ai/sdk
```

## Usage

```ts
import { AnthropicModel, AnthropicModels } from "@agentkit-js/model-anthropic";
const model = new AnthropicModel(AnthropicModels.SONNET_4_6, {
  apiKey: process.env.ANTHROPIC_API_KEY,
});
```

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
