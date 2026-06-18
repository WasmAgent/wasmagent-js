# /model-moonshot

Moonshot / Kimi K2.6 adapter — per-version reasoning field handling + auto-prefix cache.

> Part of [wasmagent](https://github.com/WasmAgent/wasmagent-js) — a TypeScript + WASM agent runtime.

> ▽ **Maintenance-mode.** This adapter is functional and security-patched, but is **not** receiving proactive feature work — it is dominated by `GenericOpenAICompatModel` + a recipe in [`docs/guides/openai-compat-recipes.md`](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/openai-compat-recipes.md). See [maintenance tiers](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/strategy/maintenance-tiers.md) for the rationale. If you actively use this package and want it promoted to ◆ Narrative, open an issue tagged `tier:promote-request` with your use case.

## Install

```bash
npm install /model-moonshot /core
```

## Usage

```ts
import { MoonshotModel, KimiModels } from "/model-moonshot";

const model = new MoonshotModel(KimiModels.K2_6, {
  apiKey: process.env.MOONSHOT_API_KEY,
  thinking: { type: "enabled" },
});
```

> ⚠️ **Compliance** — Review the [Moonshot terms](https://platform.moonshot.cn/docs/agreement) before sending production data.

## License

[Apache-2.0](./LICENSE) — © wasmagent contributors
