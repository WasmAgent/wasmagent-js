# /model-zhipu

Zhipu GLM-5 adapter — `thinking: { type }` via `extra_body`, auto-prefix cache.

> Part of [wasmagent](https://github.com/WasmAgent/wasmagent-js) — a TypeScript + WASM agent runtime.

> ▽ **Maintenance-mode.** This adapter is functional and security-patched, but is **not** receiving proactive feature work — it is dominated by `GenericOpenAICompatModel` + a recipe in [`docs/guides/openai-compat-recipes.md`](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/openai-compat-recipes.md). See [maintenance tiers](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/strategy/maintenance-tiers.md) for the rationale. If you actively use this package and want it promoted to ◆ Narrative, open an issue tagged `tier:promote-request` with your use case.

## Install

```bash
npm install /model-zhipu /core
```

## Usage

```ts
import { ZhipuModel, GLMModels } from "/model-zhipu";

const model = new ZhipuModel(GLMModels.GLM_5, {
  apiKey: process.env.ZHIPU_API_KEY,
});
```

> ⚠️ **Compliance** — Review the [Zhipu BigModel terms](https://open.bigmodel.cn/) before using in production.

## License

[Apache-2.0](./LICENSE) — © wasmagent contributors
