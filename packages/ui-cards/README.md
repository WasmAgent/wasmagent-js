# @agentkit-js/ui-cards

Card block parser — extracts ```card:* fenced blocks (Markdown / D2 / extensible) from AI replies.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

> ▽ **Maintenance-mode.** This package is functional and security-patched, but is **not** receiving proactive feature work — it is off the "embedded runtime" thesis path. See [maintenance tiers](https://github.com/telleroutlook/agentkit-js/blob/main/docs/strategy/maintenance-tiers.md) for the rationale. If you actively use this package and want it promoted to ◆ Narrative, open an issue tagged `tier:promote-request` with your use case.

## Install

```bash
npm install @agentkit-js/ui-cards
```

## Usage

```ts
import { parseCards } from "@agentkit-js/ui-cards";
const cards = parseCards(modelText);
```

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
