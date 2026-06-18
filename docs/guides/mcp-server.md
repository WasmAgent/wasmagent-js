# Expose an agentkit agent as an MCP server (F1)

The `@wasmagent/mcp-server` package wraps any object that runs like an
agent — `ToolCallingAgent`, `CodeAgent`, or any custom `SubagentRunnable` —
in a Model Context Protocol server. Hosts that already speak MCP (Claude Code,
Cursor 2.4+, Copilot, Gemini CLI, Bedrock AgentCore, Microsoft Agent
Framework) can then invoke your agent like any other MCP tool — list its
capabilities, call it synchronously, or kick off long-running tasks they
poll later.

## Why this exists

agentkit-js was previously a one-way MCP citizen: it consumed MCP servers
through `McpToolCollection`, but no host could call an agentkit agent. F1
closes the loop. The same Workers/Node deployment that runs your agent now
ships its own MCP endpoint — no extra service, no protocol drift.

## Quick start

```ts
import { ToolCallingAgent } from "@wasmagent/core";
import {
  McpAgentServer,
  createFetchHandler,
  InMemoryTaskStore,
} from "@wasmagent/mcp-server";

const agent = new ToolCallingAgent({ /* your agent */ });

const server = new McpAgentServer({
  serverInfo: { name: "my-coding-agent", version: "1.0.0" },
  agent,
  // Default: one tool 'run_agent' that takes { task: string }.
  // You can publish multiple narrower tools by passing them explicitly.
  taskStore: new InMemoryTaskStore(), // swap for KV-backed in production
});

// Streamable HTTP — works in Cloudflare Workers, Bun.serve, Node 18+.
const handler = createFetchHandler(server, { path: "/mcp" });

// In your worker:
export default {
  async fetch(request: Request) {
    return handler(request);
  },
};
```

A host configures your endpoint:

```jsonc
{
  "mcpServers": {
    "my-coding-agent": {
      "url": "https://my-worker.workers.dev/mcp"
    }
  }
}
```

After `initialize`, the host can call `tools/list`, `tools/call`,
`tasks/create`, `tasks/get`, `tasks/cancel`, and `tasks/respond`. The
underlying agent runs once per call; events stream into the persisted task
record so a worker recycle never loses progress.

## Methods

| Method | Purpose | Notes |
|---|---|---|
| `initialize` | Capability handshake | Returns `protocolVersion: "2025-11-25"` and `capabilities.tools` + `capabilities.tasks` |
| `tools/list` | List advertised tools | `_meta.longRunning` hints route to Tasks |
| `tools/call` | Synchronous tool call | Auto-escalates to Tasks when `syncTimeoutMs` fires; the response then carries `_meta.taskId` |
| `tasks/create` | Start a long task | Returns `{ id, state: "pending" }` |
| `tasks/get` | Poll a task | Returns the full `McpTaskRecord` with state, events, result, error, or pending elicitation |
| `tasks/cancel` | Cancel an in-flight task | Sets state to `failed` with `error: "cancelled by host"` |
| `tasks/respond` | Reply to an elicitation | Required after the agent emits `await_human_input` |
| `tasks/list` | Enumerate tasks | Optional — depends on the store implementing `list()` |
| `ping` | Liveness check | Returns `{}` |

## Long-running tasks (the 2025-11-25 Tasks API)

When an agent's work exceeds `syncTimeoutMs` (default 25 s), the synchronous
`tools/call` response transparently escalates to the Tasks API. The host gets
back `{ _meta: { taskId } }` and polls `tasks/get` until `state` is `complete`,
`failed`, or `awaiting-input`.

`McpAgentServer` keeps the run going in the background; the persisted record
moves through `pending → running → complete | failed | awaiting-input`. Every
five emitted agent events the record is flushed to the task store, so a
recycle in the middle of a 5-minute task only loses ≤4 events of progress.

## Stateless across restarts

The server holds **no in-memory session state**. Every method takes the task
id as an argument; everything else is read from the configured `McpTaskStore`.
This is the design for the 2026-07-28 Release Candidate, which removes the
session-id concept entirely. To survive a worker recycle:

1. Use a KV-backed `McpTaskStore` (write a 30-line adapter for your KV; the
   in-memory implementation in `taskStore.ts` is the contract).
2. Make the wrapped agent itself recoverable — if the agent uses
   `KvCheckpointer`, the resume path already works. The MCP server treats
   tasks as black-box runs of `agent.run(task)`; if that generator can be
   re-entered after a recycle, the server's persistence is sufficient.

## Elicitation (await_human_input)

When the agent emits `await_human_input`, the server:

1. Records `pendingElicitation` on the task and switches state to
   `awaiting-input`.
2. Stops the run — the generator is held by the agent's checkpointing
   layer, NOT by the MCP server.
3. Surfaces the prompt to the host via `tasks/get` (which echoes the
   `elicitation` field back).

The host calls `tasks/respond` with the user's reply; the server clears the
pending field and flips state back to `running`. Resuming the agent's actual
generator from that point is the responsibility of the host's
`CheckpointableRun` plumbing — F1 deliberately does not own that path
(letting it would create two competing resume mechanisms in the codebase).

## Per-tool customisation

Publish more than one tool by passing the `tools` option:

```ts
new McpAgentServer({
  serverInfo: { name: "...", version: "1.0" },
  agent,
  tools: [
    {
      name: "summarise_pr",
      description: "Summarise a GitHub PR by URL.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      // Convert the host's structured args into the task string the agent expects.
      resolveTask: ({ url }) => `Summarise this PR: ${url}`,
    },
    {
      name: "deep_research",
      description: "Multi-source research with verification — long running.",
      inputSchema: { type: "object", properties: { question: { type: "string" } } },
      longRunning: true,
      resolveTask: ({ question }) => `Research: ${question}`,
    },
  ],
});
```

Tools with `longRunning: true` always go through `tasks/create` regardless
of `syncTimeoutMs`.

## Spec compliance notes

- Targets MCP **2025-11-25** stable for over-the-wire compatibility with
  every shipping host.
- Designed within **2026-07-28 RC** constraints: no session-id reliance, no
  unsolicited server-initiated requests, elicitation only inside an active
  request's response.
- JSON-RPC 2.0 envelope, batch support, the standard `-32700 / -32600 /
  -32601 / -32602 / -32603` error codes plus MCP-extended `-32010 /
  -32011 / -32012` for task-not-found, tool-not-found, and
  task-not-awaiting.
