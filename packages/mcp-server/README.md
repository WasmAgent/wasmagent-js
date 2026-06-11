# @agentkit-js/mcp-server

Expose any agentkit-js agent as a Model Context Protocol (MCP) server.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/mcp-server @agentkit-js/core @modelcontextprotocol/sdk
```

## Usage

Wraps your agent's run loop in MCP so Claude Desktop, IDEs, and other MCP clients can call it
as a tool. Supports synchronous `tools/call` and the 2025-11-25 Tasks extension for long-running runs.

```ts
import { McpAgentServer } from "@agentkit-js/mcp-server";

const server = new McpAgentServer({ agent: myAgent });
await server.serve(); // listens on stdio (or pass { transport: "sse" } for HTTP)
```

See [docs/guides/mcp-server.md](https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/mcp-server.md).

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
