# @agentkit-js/core

Agent runtime — agents, kernels, models, tools, quality runners, evals, checkpoints.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/core @anthropic-ai/sdk
```

## Usage

```ts
import { CodeAgent, AnthropicModel, AnthropicModels } from "@agentkit-js/core";

const agent = new CodeAgent({
  model: new AnthropicModel(AnthropicModels.SONNET_4_6, { apiKey: process.env.ANTHROPIC_API_KEY }),
});

const result = await agent.run({ task: "What is 12 * 13?" });
console.log(result.finalAnswer);
```

See the [main README](https://github.com/telleroutlook/agentkit-js#readme) for the full surface area:
agents, runners, kernels, models, tools, evals, checkpoints, and observability.

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
