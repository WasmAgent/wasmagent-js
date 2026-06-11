# @agentkit-js/a2a

A2A (Agent2Agent) adapter — expose agents as A2A servers and call remote A2A agents.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/a2a @agentkit-js/core
```

## Usage

```ts
import { A2AServer, A2ARemoteAgent } from "@agentkit-js/a2a";
import { CodeAgent, AnthropicModel } from "@agentkit-js/core";

// Expose your agent as A2A:
const server = new A2AServer(new CodeAgent({ model: new AnthropicModel(/*...*/) }));

// Or call a remote A2A agent as a tool:
const remote = new A2ARemoteAgent({ url: "https://other-team.example/a2a" });
```

Aligns with the [Agent2Agent](https://github.com/google/A2A) protocol so agentkit-js
agents interoperate with frameworks that support A2A (Google ADK, CrewAI 1.14+, etc.).

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
