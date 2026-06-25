# @wasmagent/mcp-gateway

MCP Gateway — identity propagation, server card validation, policy enforcement, and AEP evidence emission for MCP tool invocations.

Extends `@wasmagent/mcp-firewall` with per-request identity (`RequestIdentity`), server card snapshots (`ServerCard`), and state-changing action approval via `MCPGateway`.

## Install

```bash
npm install @wasmagent/mcp-gateway
```

## Usage

```ts
import { MCPGateway, createRequestIdentity, buildServerCard } from "@wasmagent/mcp-gateway";

const identity = createRequestIdentity({
  principal: "user-123",
  sessionId: "session-abc",
});

const card = buildServerCard({
  serverId: "my-mcp-server",
  tools: registeredTools,
  operatorVerified: true,
});

const gateway = new MCPGateway({ identity, serverCard: card });
const decision = await gateway.evaluate(toolEntry, args);

if (decision.action === "deny") throw new Error("Blocked by gateway policy");
```

## Documentation

- [MCP firewall attack demos](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/security/mcp-firewall-attack-demos.md)
- [Security governance pack](https://WasmAgent.github.io/wasmagent-js/security-governance-pack/)

## License

Apache-2.0
