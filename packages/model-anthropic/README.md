# /model-anthropic

Anthropic Claude adapter — auto prompt-cache breakpoints + 1-hour TTL.

> Part of [wasmagent](https://github.com/WasmAgent/wasmagent-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install /model-anthropic /core @anthropic-ai/sdk
```

## Usage

```ts
import { AnthropicModel, AnthropicModels } from "/model-anthropic";
const model = new AnthropicModel(AnthropicModels.SONNET_LATEST, {
  apiKey: process.env.ANTHROPIC_API_KEY,
});
```

## License

[Apache-2.0](./LICENSE) — © wasmagent contributors
