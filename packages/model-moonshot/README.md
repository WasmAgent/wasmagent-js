# @agentkit-js/model-moonshot

Moonshot / Kimi K2.6 adapter — per-version reasoning field handling + auto-prefix cache.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/model-moonshot @agentkit-js/core
```

## Usage

```ts
import { MoonshotModel, KimiModels } from "@agentkit-js/model-moonshot";

const model = new MoonshotModel(KimiModels.K2_6, {
  apiKey: process.env.MOONSHOT_API_KEY,
  thinking: { type: "enabled" },
});
```

> ⚠️ **Compliance** — Review the [Moonshot terms](https://platform.moonshot.cn/docs/agreement) before sending production data.

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
