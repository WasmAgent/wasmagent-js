# @agentkit-js/model-qwen

Qwen3 (Alibaba DashScope) adapter — `enable_thinking` + `thinking_budget`, intl region routing.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/model-qwen @agentkit-js/core
```

## Usage

```ts
import { QwenModel, QwenModels } from "@agentkit-js/model-qwen";

const model = new QwenModel(QwenModels.QWEN3_MAX, {
  apiKey: process.env.DASHSCOPE_API_KEY,
  region: "intl", // or "cn"
  enable_thinking: true,
  thinking_budget: 10000,
});
```

> ⚠️ **Compliance** — Review [Alibaba Cloud DashScope terms](https://help.aliyun.com/zh/model-studio/) for cross-border data transfer rules.

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
