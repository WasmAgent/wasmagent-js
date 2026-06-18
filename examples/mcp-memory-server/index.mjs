/**
 * mcp-memory-server.ts — minimal MCP server that exposes memory CRUD as
 * 4 tools any MCP host (Claude Desktop, Cursor, Glama, …) can call.
 *
 * This is the agentkit-js equivalent of running a Mem0/Letta/Zep MCP
 * memory bridge in front of a host: the host speaks MCP; agentkit
 * provides storage + namespacing + TTL via `StructuredMemory`.
 *
 * Wire shape (matches MCP 2025-11 stdio transport):
 *   - 4 tools: memory_read, memory_write, memory_list, memory_delete
 *   - Each tool takes a JSON object via `tools/call`; returns structured
 *     content the host renders to the model.
 *   - No agent loop, no LLM in this process. The host's model is what
 *     decides when to call which tool.
 *
 * Backend: by default an in-memory `MapKvBackend` (data lost on
 * process restart — fine for "talk-with-Claude-Desktop" smoke testing).
 * For production, set `AGENTKIT_MEMORY_BACKEND=redis|cf-kv` and provide
 * the connection details (see comments at the bottom for the
 * adapter-import pattern; we deliberately do not import Redis / CF
 * adapters at the top level so this example stays zero-dep beyond
 * @wasmagent/core + @wasmagent/mcp-server).
 *
 * Usage from any MCP host:
 *
 *   {
 *     "command": "node",
 *     "args": ["./examples/mcp-memory-server/index.mjs"]
 *   }
 *
 * Glama / Claude Desktop / Cursor all accept this shape.
 */

import {
  InMemoryStructuredKv,
  StructuredMemory,
} from "@wasmagent/core";
import { McpAgentServer, runStdio } from "@wasmagent/mcp-server";

// ── Backend selection ────────────────────────────────────────────────────────

/**
 * Replace this with a Redis/CFKV-backed adapter for production. The
 * default is process-local, so a Claude Desktop session keeps memory
 * for the duration of the conversation but loses it on restart — fine
 * for a demo; not fine if you want the assistant to remember things
 * across days. See packages/core/src/checkpoint/redis.ts for the
 * Redis adapter.
 */
const memory = new StructuredMemory(new InMemoryStructuredKv());

// ── Tool implementations ────────────────────────────────────────────────────
//
// Each MCP tool resolves to a JSON-encoded "task" string the synthetic
// agent below interprets. This mirrors codeMode.ts in the same package
// (the standard agentkit-js pattern for MCP servers that don't actually
// run an LLM).

const tools = [
  {
    name: "memory_read",
    description:
      "Read a value from agentkit memory. Returns the stored value (any " +
      "JSON-serializable shape) or `null` if no entry exists.",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: {
        key: {
          type: "string",
          description: "The key to read (e.g. 'user:42:profile').",
        },
        namespace: {
          type: "string",
          enum: ["episodic", "semantic", "procedural"],
          description:
            "Memory namespace. 'episodic' = 7d TTL recent events; " +
            "'semantic' = persistent stable facts; 'procedural' = 30d TTL skills. " +
            "Defaults to 'semantic'.",
        },
      },
    },
    resolveTask: (input) =>
      JSON.stringify({
        op: "read",
        key: String(input.key ?? ""),
        namespace: String(input.namespace ?? "semantic"),
      }),
  },
  {
    name: "memory_write",
    description:
      "Store a value under a key in agentkit memory. Overwrites an " +
      "existing entry. Use for stable user facts (semantic), recent " +
      "session events (episodic), or learned how-tos (procedural).",
    inputSchema: {
      type: "object",
      required: ["key", "value"],
      properties: {
        key: { type: "string" },
        value: {
          description:
            "Any JSON-serializable value. Strings, numbers, booleans, " +
            "arrays, and objects all work.",
        },
        namespace: {
          type: "string",
          enum: ["episodic", "semantic", "procedural"],
          description: "Defaults to 'semantic' (persistent).",
        },
      },
    },
    resolveTask: (input) =>
      JSON.stringify({
        op: "write",
        key: String(input.key ?? ""),
        value: input.value ?? null,
        namespace: String(input.namespace ?? "semantic"),
      }),
  },
  {
    name: "memory_list",
    description:
      "List entries by key prefix. Useful before write to check if a " +
      "key already exists, or to surface what's stored about a user.",
    inputSchema: {
      type: "object",
      properties: {
        prefix: {
          type: "string",
          description: "Key prefix to filter on. Empty = list all.",
        },
        namespace: {
          type: "string",
          enum: ["episodic", "semantic", "procedural"],
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max entries to return. Default 50.",
        },
      },
    },
    resolveTask: (input) =>
      JSON.stringify({
        op: "list",
        prefix: String(input.prefix ?? ""),
        namespace: String(input.namespace ?? "semantic"),
        limit: Number(input.limit ?? 50),
      }),
  },
  {
    name: "memory_delete",
    description:
      "Delete an entry by key. Idempotent — deleting a missing key " +
      "succeeds silently. Use to forget user-requested data or to " +
      "correct stale facts.",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: {
        key: { type: "string" },
        namespace: {
          type: "string",
          enum: ["episodic", "semantic", "procedural"],
        },
      },
    },
    resolveTask: (input) =>
      JSON.stringify({
        op: "delete",
        key: String(input.key ?? ""),
        namespace: String(input.namespace ?? "semantic"),
      }),
  },
];

// ── Synthetic dispatch agent ─────────────────────────────────────────────────
//
// McpAgentServer wraps a `SubagentRunnable` that handles each "task"
// string. We never call an LLM here — the agent is just a JSON parser
// that routes to the right `StructuredMemory` op and yields a single
// final_answer event with the result.

const agent = {
  async *run(task) {
    const traceId = `memserver-${Date.now().toString(36)}`;
    let parsed;
    try {
      parsed = JSON.parse(task);
    } catch {
      yield {
        traceId,
        parentTraceId: null,
        timestampMs: Date.now(),
        channel: "text",
        event: "error",
        data: { error: `mcp-memory-server: malformed task: ${task.slice(0, 80)}` },
      };
      return;
    }

    const ns = parsed.namespace ?? "semantic";

    let result;
    try {
      switch (parsed.op) {
        case "read":
          result = await memory.get(String(parsed.key ?? ""), ns);
          break;
        case "write":
          await memory.set(String(parsed.key ?? ""), parsed.value, { namespace: ns });
          result = { ok: true };
          break;
        case "list": {
          const entries = await memory.query({
            namespace: ns,
            prefix: parsed.prefix,
            limit: parsed.limit ?? 50,
          });
          // Strip metadata for the wire — the model usually wants {key, value} pairs.
          result = entries.map((e) => ({ key: e.key, value: e.value }));
          break;
        }
        case "delete":
          await memory.delete(String(parsed.key ?? ""), ns);
          result = { ok: true };
          break;
        default:
          throw new Error(`unknown op: ${parsed.op}`);
      }
    } catch (e) {
      yield {
        traceId,
        parentTraceId: null,
        timestampMs: Date.now(),
        channel: "text",
        event: "error",
        data: { error: `mcp-memory-server ${parsed.op}: ${e instanceof Error ? e.message : String(e)}` },
      };
      return;
    }

    yield {
      traceId,
      parentTraceId: null,
      timestampMs: Date.now(),
      channel: "text",
      event: "final_answer",
      data: { answer: JSON.stringify(result) },
    };
  },
};

// ── Server ──────────────────────────────────────────────────────────────────

const server = new McpAgentServer({
  serverInfo: {
    name: "agentkit-mcp-memory-server",
    version: "0.1.0",
  },
  agent,
  tools,
  // Memory ops are sub-millisecond against MapKvBackend; never long-running.
  // Set allowSyncCalls=true (default) so the host gets results in the
  // tools/call response without going through the Tasks API.
  allowSyncCalls: true,
});

await runStdio(server);

// ── Production backend swap (commented for reference) ───────────────────────
//
// Replace the in-memory backend at the top of this file with one of:
//
//   import { RedisKvBackend } from "@wasmagent/core/checkpoint";
//   const kv = adaptStructuredKvBackend(new RedisKvBackend({ url: process.env.REDIS_URL }));
//
//   import { CloudflareKvBackend } from "@wasmagent/cloudflare-worker";
//   const kv = adaptStructuredKvBackend(new CloudflareKvBackend(env.MEMORY_KV));
//
// (The CF Worker path has its own deployment shape — see
// `examples/cf-production/` for that variant.)
