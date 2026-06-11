# @agentkit-js/model-doubao

Doubao / Volcengine Ark adapter — thinking tiers + `auto-prefix` / `ark-context` cache strategies.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

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
