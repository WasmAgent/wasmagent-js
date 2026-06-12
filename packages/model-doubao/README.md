# @agentkit-js/model-doubao

Doubao / Volcengine Ark adapter — thinking tiers + `auto-prefix` / `ark-context` cache strategies.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

> ▽ **Maintenance-mode.** This adapter is functional and security-patched, but is **not** receiving proactive feature work — it is dominated by `GenericOpenAICompatModel` + a recipe in [`docs/guides/openai-compat-recipes.md`](https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/openai-compat-recipes.md). See [maintenance tiers](https://github.com/telleroutlook/agentkit-js/blob/main/docs/strategy/maintenance-tiers.md) for the rationale. If you actively use this package and want it promoted to ◆ Narrative, open an issue tagged `tier:promote-request` with your use case.

## Install

```bash
npm install @agentkit-js/model-doubao @agentkit-js/core
```

## Usage

```ts
import { DoubaoModel, DoubaoModels } from "@agentkit-js/model-doubao";

const model = new DoubaoModel(DoubaoModels.DOUBAO_SEED_1_6, {
  apiKey: process.env.DOUBAO_API_KEY,
  thinking: { mode: "enabled", effort: "high" },
});
```

> ⚠️ **Compliance** — Volcengine Ark may store request/response data per its [terms of service](https://www.volcengine.com/docs/82379). Review your data residency requirements before using in production.

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
