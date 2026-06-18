# /model-qwen

Qwen3 (Alibaba DashScope) adapter — `enable_thinking` + `thinking_budget`, intl region routing.

> Part of [wasmagent](https://github.com/WasmAgent/wasmagent-js) — a TypeScript + WASM agent runtime.

> ▽ **Maintenance-mode.** This adapter is functional and security-patched, but is **not** receiving proactive feature work — it is dominated by `GenericOpenAICompatModel` + a recipe in [`docs/guides/openai-compat-recipes.md`](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/openai-compat-recipes.md). See [maintenance tiers](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/strategy/maintenance-tiers.md) for the rationale. If you actively use this package and want it promoted to ◆ Narrative, open an issue tagged `tier:promote-request` with your use case.

## Install

```bash
npm install /model-qwen /core
```

## Usage

```ts
import { QwenModel, QwenModels } from "/model-qwen";

const model = new QwenModel(QwenModels.QWEN3_MAX, {
  apiKey: process.env.DASHSCOPE_API_KEY,
  region: "intl", // or "cn"
  enable_thinking: true,
  thinking_budget: 10000,
});
```

> ⚠️ **Compliance** — Review [Alibaba Cloud DashScope terms](https://help.aliyun.com/zh/model-studio/) for cross-border data transfer rules.

## License

[Apache-2.0](./LICENSE) — © wasmagent contributors
