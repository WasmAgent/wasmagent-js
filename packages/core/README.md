# @wasmagent/core

> **Maturity: stable** — semver-compatible API; breaking changes require a major bump.

Agent runtime — agents, kernels, models, tools, quality runners, evals, checkpoints.

> Part of [wasmagent](https://github.com/WasmAgent/wasmagent-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @wasmagent/core @anthropic-ai/sdk
```

## Usage

`CodeAgent.run()` returns an `AsyncGenerator<AgentEvent>` — consume events with `for await`:

```ts
import { CodeAgent, AnthropicModel, AnthropicModels } from "@wasmagent/core";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const agent = new CodeAgent({
  model: new AnthropicModel(AnthropicModels.SONNET_LATEST, { apiKey: process.env.ANTHROPIC_API_KEY }),
  tools: [],
  kernel: new QuickJSKernel(),
});

for await (const event of agent.run("What is 12 * 13?")) {
  if (event.event === "final_answer") {
    console.log("Answer:", event.data);
  }
}
```

### Event types

| Event | Description |
|-------|-------------|
| `run_start` | Agent run initiated |
| `step_start` | New reasoning step |
| `thinking_delta` | Model thinking stream |
| `model_done` | Model generation complete |
| `action` | Code extracted for execution |
| `observation` | Kernel execution result |
| `final_answer` | Final answer resolved |
| `error` | Error encountered |

See the [main README](https://github.com/WasmAgent/wasmagent-js#readme) for the full surface area:
agents, runners, kernels, models, tools, evals, checkpoints, and observability.

## License

[Apache-2.0](./LICENSE) — © wasmagent contributors
