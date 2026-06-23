# MCP Portal example (D1, 2026-06-13)

Federate 3 tool sources behind ONE two-tool MCP surface (`docs_search` +
`execute_code`):

| Upstream | What it is |
|---|---|
| `fs` | filesystem-style (`read_file`, `list_dir`) |
| `github` | GitHub-like (`list_repos`, `create_issue`) |
| `memory` | WasmAgent's built-in `createMemoryTool({ backend })` |

What the host MCP client sees:

```
tools/list → ['docs_search', 'execute_code']
```

What `docs_search` returns (truncated):

```
### fs__read_file
[fs — workspace files] Read a UTF-8 file from the workspace.

### fs__list_dir
[fs — workspace files] List the entries of a directory.

### github__list_repos
[github — Git hosting] List repositories in an org.

### github__create_issue
[github — Git hosting] Open an issue on a repository.

### memory__memory
[memory — cross-session memory] Cross-session memory: create / read / list / delete.
```

What an `execute_code` script can do:

```js
const repos = await callTool("github__list_repos", { org: "telleroutlook" });
const dir   = await callTool("fs__list_dir", { path: "/workspace" });
await callTool("memory__memory", { op: "write", key: "/notes/portal-demo", value: "hello" });
return { repos, dir };
```

All three upstreams are governed by **one** `CapabilityManifest` (no
network except `api.github.com`, no fs writes, 5 s CPU cap). That's the
audit boundary platform-bound Portals (Cloudflare, etc.) cannot give you
across heterogeneous providers.

## Run

```bash
node examples/mcp-portal/index.mjs
```

## Swap kernels for production

```ts
import { createPortalServer } from "@wasmagent/mcp-server";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs"; // edge-safe WASM
// or:
import { RemoteSandboxKernel } from "@wasmagent/core";       // microVM (E2B / CF Sandbox)

createPortalServer({ ...same config..., kernel: new QuickJSKernel() });
```

## Where to plug in real MCP servers

Anything that exposes a `ToolRegistry`-shaped surface plugs in. For real
upstream MCP servers, use `McpToolCollection.fromHttp()` /
`fromStdio()` in `@wasmagent/core` and pass the resulting collection
as `tools`.

## Token math

See `examples/benchmarks/portal-tokens.mjs` — at 5 servers × 30 tools
(150 tools total), the Portal is **3.1%** of direct multi-MCP token cost
and **19.8%** of code-mode-per-server. Bootstrap is constant in the
number of servers federated.
