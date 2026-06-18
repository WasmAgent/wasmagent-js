# mcp-memory-server — agentkit memory as an MCP server

A minimal MCP server that exposes 4 memory tools — `memory_read`,
`memory_write`, `memory_list`, `memory_delete` — backed by
[`@wasmagent/core`'s `StructuredMemory`](../../packages/core/src/memory/StructuredMemory.ts).
Drops into any MCP-compatible host (Claude Desktop, Cursor, Glama,
your own client) so the model on the other side can persist and
recall facts across turns.

The agentkit equivalent of running a [Mem0](https://github.com/mem0ai/mem0) /
[Letta](https://github.com/letta-ai/letta) / [Zep](https://github.com/getzep/zep)
memory bridge: same shape (MCP tools), different backend (you own the
storage and the namespace semantics). Single file, ~200 lines, no LLM
in the server process — the host's model decides when to read/write.

## What you get

Four tools, each maps 1-to-1 to a `StructuredMemory` op:

| Tool | Op | Notes |
|---|---|---|
| `memory_read({key, namespace?})` | `memory.get(key, ns)` | Returns `null` if missing |
| `memory_write({key, value, namespace?})` | `memory.set(key, value, {namespace})` | Overwrites; any JSON value |
| `memory_list({prefix?, namespace?, limit?})` | `memory.query({namespace, prefix, limit})` | Returns `[{key, value}]` (metadata stripped) |
| `memory_delete({key, namespace?})` | `memory.delete(key, ns)` | Idempotent |

`namespace` defaults to `"semantic"` (persistent). Other choices:
`"episodic"` (7-day TTL) and `"procedural"` (30-day TTL). See
[StructuredMemory](../../packages/core/src/memory/StructuredMemory.ts)
for the lifecycle semantics.

## Quick start

Build the workspace once, then run from the example dir:

```bash
# from repo root
bun install
bun run -F '@wasmagent/core' build
bun run -F '@wasmagent/mcp-server' build

# then
cd examples/mcp-memory-server
node index.mjs
```

The server speaks newline-delimited JSON-RPC on stdin/stdout. Test it
with a one-shot `initialize`:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' | node index.mjs
```

Should print a single response advertising `serverInfo.name:
agentkit-mcp-memory-server` and exit.

## Wiring into Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or the equivalent on Windows:

```json
{
  "mcpServers": {
    "agentkit-memory": {
      "command": "node",
      "args": ["/absolute/path/to/agentkit-js/examples/mcp-memory-server/index.mjs"]
    }
  }
}
```

Restart Claude Desktop. The 4 memory tools appear in the tool list;
Claude will call them when prompted to "remember X" / "what do you
know about me".

## Wiring into Cursor

Cursor uses the same MCP config shape — settings → MCP → Add Server →
paste the same JSON. After a reload, ask Cursor to "remember my
preferred test framework is vitest" and watch it call `memory_write`.

## Wiring into Glama

Glama can host MCP servers directly. The repo's
[`Dockerfile.glama`](../../packages/mcp-server/Dockerfile.glama)
ships the **code-mode** server (separate use case). For the memory
server specifically, write a similar Dockerfile that runs
`node examples/mcp-memory-server/index.mjs` as `CMD`.

## Production: persistent backend

The default `MapKvBackend` is **process-local** — memory is lost when
the process exits. For a real "remembers across days" behaviour, swap
in a persistent backend.

Comments at the bottom of `index.mjs` show the import pattern. Two
common options:

### Redis (any host)

```ts
import { RedisKvBackend } from "@wasmagent/core/checkpoint";
const kv = adaptStructuredKvBackend(
  new RedisKvBackend({ url: process.env.REDIS_URL }),
);
```

### Cloudflare KV (Workers / Pages)

```ts
import { CloudflareKvBackend } from "@wasmagent/cloudflare-worker";
const kv = adaptStructuredKvBackend(new CloudflareKvBackend(env.MEMORY_KV));
```

The CF Worker path needs its own deployment shape (Worker entry, not
stdio) — see [`examples/cf-production/`](../cf-production/) for the
HTTP variant of the same MCP server.

## Anti-patterns

**Don't put PII in `episodic`.** 7-day TTL doesn't satisfy GDPR
"right to be forgotten" — that's a `memory_delete` flow, not a
TTL-based decay.

**Don't write large values.** `StructuredMemory` is a KV; values >100KB
should be vector-indexed via `@wasmagent/tools-rag` or stored as
references (e.g. `memory_write({key, value: { docId: "..." }})`).

**Don't skip the namespace.** A model that always writes to
`semantic` ends up with everything persistent forever. Coach it via
the system prompt to pick the right namespace per fact.

## See also

- [Memory overview guide](../../docs/guides/memory.md) — when to use
  this MCP server vs. the in-process primitives
- [Memory patterns reference](../../docs/guides/memory-patterns.md) —
  TTL/decay/`createMemoryTool` details
- [`MemoryBlocks.ts`](../../packages/core/src/memory/MemoryBlocks.ts) —
  Letta-style core memory blocks (different lifecycle, in-context
  rather than tool-fetched)
