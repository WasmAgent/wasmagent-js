# @agentkit-js/agent-prompts

Reusable system prompt templates for agentkit-js — code/tool/framework prompts with D2 + Markdown card conventions.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/agent-prompts
```

## Usage

```ts
import { composePrompt, codeAgentPrompt, cardConventions } from "@agentkit-js/agent-prompts";

const system = composePrompt([codeAgentPrompt(), cardConventions()]);
```

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
