/**
 * createPortalServer — D1 (S1 strategic line, 2026-06-13).
 *
 * **What this is.** A *neutral, multi-server* MCP Portal: federate N upstream
 * MCP servers (or any agentkit `ToolRegistry`) behind the same two-tool
 * code-mode surface (`docs_search` + `execute_code`). The host sees one
 * gateway with one auth surface and one capability manifest; the model sees
 * one combined tool catalogue and dispatches them in-sandbox.
 *
 * **Why now.** Cloudflare announced *MCP Server Portals* (2026-Q2): the same
 * pattern, but locked to their platform. The market still has no
 * self-hostable, runtime-neutral Portal. agentkit's three-tier kernel +
 * `CapabilityManifest` already give us everything Cloudflare's version
 * promises *except* the federation step — that's what this module adds.
 *
 * **Strategic guarantees the platform-bound version cannot make.**
 *
 *   1. Runtime-neutral: same Portal runs on Node, any edge runtime, browser
 *      (with a WASM kernel), and a laptop with no network (with
 *      `@agentkit-js/model-local`). The kernel choice and the upstream list
 *      are decoupled.
 *   2. One auditable security policy: every `execute_code` invocation runs
 *      under the *same* `CapabilityManifest` regardless of which upstream the
 *      script's `callTool()` reaches into. The manifest is the audit boundary.
 *   3. Token math identical to direct code-mode: the Portal still publishes
 *      exactly two tools, so the bootstrap-token saving compounds across
 *      upstreams instead of multiplying.
 *
 * **Non-goals.** This module does NOT speak MCP transport to upstreams —
 * agentkit-js already has `McpToolCollection.fromHttp()` /
 * `fromStdio()` for that. The Portal accepts anything that exposes a
 * `ToolRegistry`-shaped surface, so any transport agentkit can already
 * connect to (HTTP / stdio / WebSocket via the MCP SDK; in-process tool
 * registries; `@agentkit-js/aisdk` adapters; future transports) plugs in
 * without changes here.
 */

import type {
  CapabilityManifest,
  ToolDefinition,
  ToolRegistry,
  WasmKernel,
} from "@agentkit-js/core";
import { ToolRegistry as ToolRegistryCtor } from "@agentkit-js/core";
import { type CodeModeServerOptions, createCodeModeServer } from "./codeMode.js";
import type { McpAgentServer } from "./McpAgentServer.js";
import type { McpServerInfo, McpTaskStore } from "./types.js";

/**
 * One federated upstream. The Portal accepts a stable identifier (used as
 * the namespace prefix in `docs_search` results and as the routing key in
 * `callTool`) and any object exposing the `ToolRegistry` shape.
 *
 * The `tools` field is intentionally typed as `ToolRegistry`-like, not as
 * `McpToolCollection` — the latter is a strict subclass but we want to keep
 * the seam open so a non-MCP source (e.g. `@agentkit-js/aisdk` adapter,
 * built-in tool sets, the Memory Tool) can be federated without first being
 * round-tripped through MCP.
 */
export interface McpPortalUpstream {
  /**
   * Stable, host-readable identifier. Used as:
   *   - the namespace prefix for tool names in `docs_search`
   *     (e.g. `github`, `fs`, `memory`).
   *   - the routing key inside `execute_code` — `callTool("github__list_repos", …)`
   *     resolves to this upstream when the tool name starts with `<id>__`.
   *
   * Must match `^[a-z0-9][a-z0-9_-]*$` to keep names round-trippable. The
   * Portal validates this at construction.
   */
  id: string;
  /**
   * The tool source. Anything with `list()` and `get()` works — `ToolRegistry`,
   * `McpToolCollection`, or a custom adapter. The Portal never mutates it.
   */
  tools: ToolRegistry;
  /**
   * Optional one-line description shown in `docs_search` headers. Useful when
   * the host or its model needs to reason about *which* upstream a tool
   * belongs to (e.g. "github — repo / issues / PR operations").
   */
  description?: string;
}

export interface CreatePortalServerOptions {
  /** Server identity advertised on `initialize`. */
  serverInfo: McpServerInfo;
  /**
   * The federated upstreams. Order matters only for `docs_search` listing;
   * tool resolution is by exact namespaced name. Empty arrays are rejected —
   * a Portal with no upstreams is a configuration mistake, not a degenerate
   * case worth supporting silently.
   */
  upstreams: McpPortalUpstream[];
  /**
   * Kernel that executes model-generated scripts. Same constraints as
   * `createCodeModeServer`: WASM or remote-sandbox in production, JsKernel
   * fine for local dev.
   */
  kernel: WasmKernel;
  /**
   * One capability manifest applied to *every* `execute_code` invocation
   * regardless of which upstream the script reaches into. This is the audit
   * boundary the platform-bound Portals cannot give you across providers.
   */
  capabilities?: Partial<CapabilityManifest>;
  /** Optional task store; defaults to in-memory (same as codeMode). */
  taskStore?: McpTaskStore;
  /** Pass through to codeMode — schemas off by default keeps tokens low. */
  includeSchemas?: boolean;
  /** Pass through to codeMode — applies to the *flattened* federated list. */
  maxDocsResults?: number;
  /**
   * Separator between the upstream id and the tool name inside the
   * federated registry. Two underscores is the de-facto MCP convention
   * (used by Anthropic Apps SDK and Claude Code's own server federation,
   * 2026). Override at your own risk — must not appear in any upstream's
   * existing tool names.
   */
  namespaceSeparator?: string;
}

/**
 * Build a federated Portal that exposes the same two-tool MCP surface as
 * {@link createCodeModeServer}, but flattens N upstreams into one tool
 * catalogue keyed by `<upstreamId><sep><toolName>`.
 *
 * The returned server is a normal `McpAgentServer`, so transport adapters
 * (`createFetchHandler`, `runStdio`) and the rest of the existing test
 * machinery work unchanged.
 */
export function createPortalServer(opts: CreatePortalServerOptions): McpAgentServer {
  const sep = opts.namespaceSeparator ?? "__";
  validateUpstreams(opts.upstreams, sep);

  const flat = flattenUpstreams(opts.upstreams, sep);

  const cmOpts: CodeModeServerOptions = {
    serverInfo: opts.serverInfo,
    tools: flat,
    kernel: opts.kernel,
  };
  if (opts.capabilities) cmOpts.capabilities = opts.capabilities;
  if (opts.taskStore) cmOpts.taskStore = opts.taskStore;
  if (opts.includeSchemas !== undefined) cmOpts.includeSchemas = opts.includeSchemas;
  if (opts.maxDocsResults !== undefined) cmOpts.maxDocsResults = opts.maxDocsResults;

  return createCodeModeServer(cmOpts);
}

// ── internals ────────────────────────────────────────────────────────────────

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function validateUpstreams(upstreams: McpPortalUpstream[], sep: string): void {
  if (!Array.isArray(upstreams) || upstreams.length === 0) {
    throw new Error(
      "createPortalServer: at least one upstream is required. " +
        "A Portal with zero upstreams is equivalent to createCodeModeServer({ tools: new ToolRegistry() }) — " +
        "if that is what you want, call createCodeModeServer directly."
    );
  }
  const seenIds = new Set<string>();
  for (const u of upstreams) {
    if (!u.id || typeof u.id !== "string") {
      throw new Error(`createPortalServer: upstream is missing a string id: ${JSON.stringify(u)}`);
    }
    if (!ID_PATTERN.test(u.id)) {
      throw new Error(
        `createPortalServer: upstream id "${u.id}" is not a valid identifier ` +
          `(must match /^[a-z0-9][a-z0-9_-]*$/).`
      );
    }
    if (u.id.includes(sep)) {
      throw new Error(
        `createPortalServer: upstream id "${u.id}" contains the namespace separator "${sep}". ` +
          `Choose a different id, or override namespaceSeparator.`
      );
    }
    if (seenIds.has(u.id)) {
      throw new Error(`createPortalServer: duplicate upstream id "${u.id}".`);
    }
    seenIds.add(u.id);
    if (!u.tools || typeof u.tools.list !== "function" || typeof u.tools.get !== "function") {
      throw new Error(
        `createPortalServer: upstream "${u.id}" is missing a ToolRegistry-shaped \`tools\` field.`
      );
    }
    // Reject upstream tool names that already contain the separator. Without
    // this, the namespace would round-trip ambiguously and we could resolve
    // to the wrong upstream on `callTool`.
    for (const t of u.tools.list()) {
      if (t.name.includes(sep)) {
        throw new Error(
          `createPortalServer: upstream "${u.id}" has a tool named "${t.name}" containing the ` +
            `namespace separator "${sep}". Rename the tool, or override namespaceSeparator.`
        );
      }
    }
  }
}

/**
 * Flatten upstreams into one `ToolRegistry` whose tool names are
 * `<upstreamId><sep><toolName>`. Each tool's `forward` is wrapped to dispatch
 * back to the original upstream — the federated registry never mutates the
 * upstream itself.
 *
 * The `description` is prefixed with `[<upstreamId>]` so `docs_search`
 * markdown stays readable when many upstreams contribute similarly-named
 * tools (e.g. multiple "list" / "get" / "create" verbs).
 */
function flattenUpstreams(upstreams: McpPortalUpstream[], sep: string): ToolRegistry {
  const flat = new ToolRegistryCtor();
  for (const u of upstreams) {
    const banner = u.description ? `[${u.id} — ${u.description}] ` : `[${u.id}] `;
    for (const t of u.tools.list()) {
      const namespacedName = `${u.id}${sep}${t.name}`;
      // Mirror every relevant field so existing kernel-side `callTool`
      // behaviour (input validation, allowedCallers gating, deferred
      // loading) keeps working. We deliberately preserve `inputSchema` /
      // `outputSchema` references — the flattened registry is a routing
      // layer, not a deep copy.
      const wrapped: ToolDefinition = {
        ...(t as ToolDefinition),
        name: namespacedName,
        description: banner + (t.description ?? ""),
        // Forward to the upstream's original definition so MCP-backed
        // upstreams continue to talk to their own client. We resolve via
        // `get(t.name)` rather than capturing `t.forward` directly so that
        // upstreams which lazy-resolve definitions still work.
        forward: async (input, signal) => {
          const upstreamDef = u.tools.get(t.name);
          if (!upstreamDef) {
            throw new Error(
              `Portal: upstream "${u.id}" no longer exposes tool "${t.name}". ` +
                `This usually means the upstream MCP server was reconfigured at runtime.`
            );
          }
          return upstreamDef.forward(input, signal);
        },
      };
      flat.register(wrapped);
    }
  }
  return flat;
}
