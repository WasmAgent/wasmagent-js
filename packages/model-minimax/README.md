# /model-minimax

MiniMax M2/M3 adapter — `reasoning_split` + `<think>` tag parsing.

> Part of [wasmagent](https://github.com/WasmAgent/wasmagent-js) — a TypeScript + WASM agent runtime.

> ▽ **Maintenance-mode.** This adapter is functional and security-patched, but is **not** receiving proactive feature work — it is dominated by `GenericOpenAICompatModel` + a recipe in [`docs/guides/openai-compat-recipes.md`](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/openai-compat-recipes.md). See [maintenance tiers](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/strategy/maintenance-tiers.md) for the rationale. If you actively use this package and want it promoted to ◆ Narrative, open an issue tagged `tier:promote-request` with your use case.

## Install

```bash
npm install /model-minimax /core
```

## Usage

```ts
import { MiniMaxModel, MiniMaxModels } from "/model-minimax";

const model = new MiniMaxModel(MiniMaxModels.M3, {
  apiKey: process.env.MINIMAX_API_KEY,
});
```

> ⚠️ **Compliance** — Review the [MiniMax terms](https://www.minimaxi.com/document/) before using in production.

## License

[Apache-2.0](./LICENSE) — © wasmagent contributors
