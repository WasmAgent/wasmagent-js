# /model-openai

OpenAI / Azure OpenAI adapter for wasmagent.

> Part of [wasmagent](https://github.com/WasmAgent/wasmagent-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install /model-openai /core openai
```

## Usage

```ts
import { OpenAIModel, OpenAIModels } from "/model-openai";
const model = new OpenAIModel(OpenAIModels.GPT_4_1, {
  apiKey: process.env.OPENAI_API_KEY,
});
```

## License

[Apache-2.0](./LICENSE) — © wasmagent contributors
