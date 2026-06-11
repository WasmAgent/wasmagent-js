# @agentkit-js/model-zhipu

Zhipu GLM-5 adapter — `thinking: { type }` via `extra_body`, auto-prefix cache.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/model-zhipu @agentkit-js/core
```

## Usage

```ts
import { ZhipuModel, GLMModels } from "@agentkit-js/model-zhipu";

const model = new ZhipuModel(GLMModels.GLM_5, {
  apiKey: process.env.ZHIPU_API_KEY,
});
```

> ⚠️ **Compliance** — Review the [Zhipu BigModel terms](https://open.bigmodel.cn/) before using in production.

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
