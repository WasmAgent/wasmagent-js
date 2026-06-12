# @agentkit-js/a2a

A2A (Agent2Agent) adapter — expose agents as A2A servers and call remote A2A agents.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

> ▽ **Maintenance-mode.** This adapter is functional and security-patched, but is **not** receiving proactive feature work while the upstream A2A protocol stabilizes and demand signals (organic downloads, integration requests) come in. See [maintenance tiers](https://github.com/telleroutlook/agentkit-js/blob/main/docs/strategy/maintenance-tiers.md) for the rationale. If you actively use this package and want it promoted to ◆ Narrative, open an issue tagged `tier:promote-request` with your use case.

## Install

```bash
npm install @agentkit-js/a2a @agentkit-js/core
```

## Usage

### Expose an agentkit-js agent as an A2A server

```ts
import { createA2AServer } from "@agentkit-js/a2a";
import { ToolCallingAgent, AnthropicModel } from "@agentkit-js/core";

const agent = new ToolCallingAgent({
  model: new AnthropicModel(/* ... */),
  tools: [/* ... */],
});

const server = createA2AServer(agent, {
  agentId: "https://example.com/agents/my-agent",
  name: "My Agent",
  description: "Does things over A2A.",
  skills: ["search.web", "calc.math"],
  port: 3000,
});

await server.start();
// → discoverable at http://localhost:3000/.well-known/agent-card
// → tasks accepted at http://localhost:3000/tasks
```

### Call a remote A2A agent as a tool

```ts
import { A2ARemoteAgent } from "@agentkit-js/a2a";
import { ToolCallingAgent } from "@agentkit-js/core";

const remoteTool = A2ARemoteAgent.asTool({
  taskEndpoint: "https://other-team.example/tasks",
  name: "remote_search",
  description: "Web search via the team's hosted A2A agent.",
  apiKey: process.env.OTHER_TEAM_API_KEY,
});

const parent = new ToolCallingAgent({ model, tools: [remoteTool] });
```

## Interoperability — proof on the wire

[`examples/a2a-interop`](https://github.com/telleroutlook/agentkit-js/tree/main/examples/a2a-interop)
runs both directions end-to-end inside one process:

- **Path A** — raw HTTP client hits `createA2AServer`. This is the path Google
  ADK / CrewAI 1.14+ / Langroid take when they discover and call our agent.
- **Path B** — `A2ARemoteAgent.asTool` calls a remote A2A endpoint. This is the
  path our agents take when calling out to an ADK / CrewAI agent.

```bash
node examples/a2a-interop/index.mjs
```

Aligns with the [Agent2Agent v1.0](https://github.com/google/A2A) protocol so
agentkit-js agents interoperate with any A2A-compliant framework (Google ADK,
CrewAI 1.14+, Langroid, …) without per-framework adapters.

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
