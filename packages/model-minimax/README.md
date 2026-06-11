# @agentkit-js/model-minimax

MiniMax M2/M3 adapter — `reasoning_split` + `<think>` tag parsing.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/model-minimax @agentkit-js/core
```

## Usage

```ts
import { MiniMaxModel, MiniMaxModels } from "@agentkit-js/model-minimax";

const model = new MiniMaxModel(MiniMaxModels.M3, {
  apiKey: process.env.MINIMAX_API_KEY,
});
```

> ⚠️ **Compliance** — Review the [MiniMax terms](https://www.minimaxi.com/document/) before using in production.

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
