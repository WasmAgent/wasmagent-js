# @agentkit-js/ui-cards

Card block parser — extracts ```card:* fenced blocks (Markdown / D2 / extensible) from AI replies.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

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
