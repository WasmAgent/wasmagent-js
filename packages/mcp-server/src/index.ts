/**
 * @agentkit-js/mcp-server — F1.
 *
 * Take any object that runs like an agent (a `SubagentRunnable`) and expose
 * it as a Model Context Protocol server. The host (Claude Code, Cursor,
 * Copilot, etc.) gets a uniform, transport-agnostic interface — JSON-RPC
 * over a request/response handler — and gains the ability to call agentkit
 * agents like any other MCP server.
 *
 * ## Why this matters strategically
 *
 * The MCP ecosystem went from "fun project" to industry-default through
 * 2025–2026: it's been adopted by Anthropic, OpenAI, Microsoft, Google,
 * and AWS, and is now governed by the Linux Foundation's AAIF. Every
 * competing agent framework already publishes its agents AS MCP servers.
 * agentkit-js previously only consumed MCP — this package closes the loop.
 *
 * ## Spec target & design constraints
 *
 *   - **2025-11-25 stable** — the version production hosts (Claude Code,
 *     Cursor 2.4+) speak today. We implement: `initialize`, `tools/list`,
 *     `tools/call`, plus the 2025-11 `tasks/*` family for long-running work.
 *   - **2026-07-28 Release Candidate constraints** — designed to be safe to
 *     run when the RC ships:
 *       1. **Stateless core**: every request is self-contained. We do NOT
 *          rely on `Mcp-Session-Id` headers or in-memory session state.
 *          Long-task state lives in a {@link Checkpointer}-backed store and
 *          is keyed by the task id, which the host echoes back on poll.
 *       2. **Elicitation only during request handling**: server-initiated
 *          requests (await_human_input → MCP elicitation) are exposed as
 *          part of the active request's response, not pushed unsolicited.
 *
 * ## What ships in this file
 *
 *   - {@link McpAgentServer} — the orchestrator. Wraps any
 *     `SubagentRunnable` and answers MCP JSON-RPC requests.
 *   - {@link createFetchHandler} — a `(Request) => Promise<Response>` adapter
 *     that runs over Streamable HTTP (Workers-compatible). Hosts that prefer
 *     stdio can call `server.handle()` directly.
 *   - {@link McpTaskStore} — minimal KV-backed task store; defaults to
 *     in-memory. The CF Workers / Node host injects its real KV.
 *
 * Transport packaging (stdio framing, HTTP routing details) is left to the
 * host: this package provides the protocol-level brain, not a CLI binary.
 */

export type { CodeModeServerOptions } from "./codeMode.js";
// A1 — code-mode server (S1 strategic line, 2026-06):
//   Two-tool MCP surface (docs_search + execute_code) that collapses N
//   downstream tools into one in-sandbox dispatch. Pairs with any kernel
//   from agentkit-js for unified security policy.
export { createCodeModeServer } from "./codeMode.js";
export { createFetchHandler } from "./fetchHandler.js";
export { McpAgentServer } from "./McpAgentServer.js";
// Stdio transport — wraps any McpAgentServer in newline-delimited
// JSON-RPC over stdin/stdout. Useful for examples that ship their own
// server (e.g. examples/mcp-memory-server) and for downstream consumers
// who want to embed agentkit's MCP layer in a Claude Desktop / Cursor /
// Glama deployment without re-implementing the wire framing.
export { runStdio } from "./stdio.js";
// D1 — neutral multi-server Portal (S1 strategic line, 2026-06-13):
//   Federate N upstream MCP servers (or any ToolRegistry) behind the same
//   two-tool code-mode surface. Same token math as direct code-mode, plus
//   one auditable CapabilityManifest spanning all upstreams. Runtime-neutral
//   counterpart to Cloudflare's announced MCP Server Portals.
export { createPortalServer } from "./portal.js";
export type { CreatePortalServerOptions, McpPortalUpstream } from "./portal.js";
export { InMemoryTaskStore } from "./taskStore.js";
export type {
  McpAgentServerOptions,
  McpHandleResult,
  McpJsonRpcId,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpServerInfo,
  McpTaskRecord,
  McpTaskState,
  McpTaskStore,
  McpToolEntry,
} from "./types.js";
