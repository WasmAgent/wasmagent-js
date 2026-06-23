# WasmAgent MCP Code-Mode Server

Code-mode collapses any number of tool definitions behind two MCP tools:

- `docs_search` — JIT-fetches tool names, descriptions, and optionally schemas
  so the model can discover capabilities without loading them all upfront.
- `execute_code` — runs a JS snippet in the kernel; the snippet may call
  `callTool(name, args)` against any registered upstream tool.

The host (Claude Code, Cursor, Copilot, …) sees only those two tools instead
of N, saving O(N) prompt tokens on every request.

## Install

```bash
npm install @wasmagent/core @wasmagent/mcp-server \
  quickjs-emscripten @jitl/quickjs-wasmfile-release-sync zod
```

For the portal (multi-upstream federation) variant, no extra package is needed —
`createPortalServer` is also in `@wasmagent/mcp-server`.

## 10-line integration — single registry

```js
import { ToolRegistry } from "@wasmagent/core";
import { createCodeModeServer, createFetchHandler } from "@wasmagent/mcp-server";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const tools = new ToolRegistry();
tools.register({ name: "search_docs",  /* … */ });
tools.register({ name: "read_file",    /* … */ });
// Register as many tools as needed — the host prompt cost stays constant.

const server = createCodeModeServer({
  serverInfo: { name: "my-code-mode", version: "1.0.0" },
  tools,
  kernel: new QuickJSKernel({ timeoutMs: 5000 }),
  capabilities: { cpuMs: 5000, memoryLimitBytes: 64 * 1024 * 1024 },
});

// Streamable HTTP — works in Node, Bun, Cloudflare Workers.
export default { fetch: createFetchHandler(server, { path: "/mcp" }) };
```

## Portal variant — federate multiple upstreams

Use `createPortalServer` when you want to federate tools from multiple
independent registries behind the same two-tool surface:

```js
import { JsKernel, ToolRegistry, MapKvBackend, createMemoryTool } from "@wasmagent/core";
import { createPortalServer } from "@wasmagent/mcp-server";

const fs     = new ToolRegistry();  // register read_file, list_dir, …
const github = new ToolRegistry();  // register list_repos, create_issue, …
const memory = new ToolRegistry();
memory.register(createMemoryTool({ backend: new MapKvBackend() }));

const portal = createPortalServer({
  serverInfo: { name: "my-portal", version: "1.0.0" },
  kernel: new JsKernel(),           // swap to QuickJSKernel for edge
  capabilities: {
    allowedHosts: ["api.github.com"],
    allowedReadPaths: ["/workspace"],
    cpuMs: 5000,
  },
  upstreams: [
    { id: "fs",     tools: fs,     description: "workspace files" },
    { id: "github", tools: github, description: "Git hosting" },
    { id: "memory", tools: memory, description: "cross-session memory" },
  ],
});
```

Upstream tools are namespaced by id: a snippet calls
`callTool("github__list_repos", { org: "acme" })`.

## In-process JSON-RPC usage (no HTTP server)

```js
async function rpc(method, params) {
  return portal.handle({ jsonrpc: "2.0", id: 1, method, params });
}

const list = await rpc("tools/list");
// → { result: { tools: [ { name: "docs_search" }, { name: "execute_code" } ] } }

const call = await rpc("tools/call", {
  name: "execute_code",
  arguments: { code: `return await callTool("fs__list_dir", { path: "/workspace" })` },
});
```

## What is enforced

- **Sandboxed execution** — `execute_code` runs JS in the configured kernel;
  snippets cannot access the host process.
- **CPU timeout** — `cpuMs` in `capabilities` caps each `execute_code` call.
- **Memory limit** — `memoryLimitBytes` caps the kernel heap.
- **Network policy** — `allowedHosts` gates outbound fetch from within snippets.

## Capability manifest example

```js
{
  allowedHosts: ["api.example.com"],
  allowedReadPaths: ["/workspace"],
  allowedWritePaths: [],
  cpuMs: 5000,
  memoryLimitBytes: 64 * 1024 * 1024,
  env: { API_KEY: process.env.API_KEY ?? "" },
}
```

## Token savings

| N tools | Direct MCP tokens | Code-mode tokens | Savings |
|---:|---:|---:|---:|
| 10 | ~1530 | ~474 | 69% |
| 30 | ~3490 | ~474 | 86% |
| 100 | ~10350 | ~474 | 95% |

Cost is O(1) regardless of how many tools are registered.

## Run

```bash
node index.mjs
```

## Configure in an MCP host

```jsonc
{
  "mcpServers": {
    "my-code-mode": {
      "url": "https://my-worker.workers.dev/mcp"
    }
  }
}
```

## See also

- Code mode deep dive: [`docs/guides/code-mode.md`](../guides/code-mode.md)
- MCP server guide: [`docs/guides/mcp-server.md`](../guides/mcp-server.md)
- Kernel decision tree: [`docs/kernels/comparison.md`](../kernels/comparison.md)
- Runnable example: [`examples/recipes/mcp-code-mode/index.mjs`](../../examples/recipes/mcp-code-mode/index.mjs)
