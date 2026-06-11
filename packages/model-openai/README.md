# @agentkit-js/model-openai

OpenAI / Azure OpenAI adapter for agentkit-js.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/model-openai @agentkit-js/core openai
```

## Usage

```ts
import { OpenAIModel, OpenAIModels } from "@agentkit-js/model-openai";
const model = new OpenAIModel(OpenAIModels.GPT_4_1, {
  apiKey: process.env.OPENAI_API_KEY,
});
```

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
