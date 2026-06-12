/**
 * createCodeModeServer — A1 (S1 strategic line, 2026-06).
 *
 * Wraps a downstream tool registry into a *code-mode* MCP server that
 * publishes only TWO tools:
 *
 *   1. `docs_search(query?, names?)` — returns type signatures + descriptions
 *      for the downstream tools, optionally filtered by substring or by name.
 *      The caller (an LLM in another agent) reads this once to learn the API.
 *
 *   2. `execute_code(code)` — runs a model-generated script in an
 *      agentkit Kernel. The script may call `callTool(name, args)` against
 *      any downstream tool. Intermediate tool outputs never leave the
 *      kernel; only the script's final return value crosses the MCP wire.
 *
 * This mirrors Cloudflare's "Code Mode MCP server" (InfoQ 2026-04) and Red Hat
 * codemode-lite (2026-04) — both validated that collapsing N tool slots into
 * one `execute_code` entry saves >50% tokens once N exceeds ~30, while keeping
 * full tool reach via in-sandbox calls. agentkit's value-add is that the
 * sandbox is the same `Kernel` interface used elsewhere (QuickJS / Pyodide /
 * Wasmtime / Remote), so the same security manifest gates network, fs, env,
 * cpu and memory uniformly across language and isolation tier.
 *
 * The function returns a `McpAgentServer` so existing transport adapters
 * (`createFetchHandler`, stdio packaging) Just Work.
 */

import type {
  CapabilityManifest,
  SubagentRunnable,
  ToolRegistry,
  WasmKernel,
} from "@agentkit-js/core";
import { ProgrammaticOrchestrator } from "@agentkit-js/core";
import { McpAgentServer } from "./McpAgentServer.js";
import { InMemoryTaskStore } from "./taskStore.js";
import type { McpAgentServerOptions, McpServerInfo, McpTaskStore } from "./types.js";

export interface CodeModeServerOptions {
  serverInfo: McpServerInfo;
  /** The downstream tools the executed code may call via `callTool(name, args)`. */
  tools: ToolRegistry;
  /**
   * Kernel used to execute model-generated scripts. Use a WASM kernel
   * (`QuickJSKernel`, `PyodideKernel`, `WasmtimeKernel`) or `RemoteSandboxKernel`
   * for production; `JsKernel` is fine for local development.
   */
  kernel: WasmKernel;
  /**
   * Capability manifest applied to every `execute_code` invocation. Honours
   * the unified policy face (allowedHosts / allowedReadPaths /
   * allowedWritePaths / env / cpuMs / memoryLimitBytes); a kernel without
   * native enforcement for some field falls back to best-effort per the
   * matrix in `CapabilityManifest`'s docblock.
   */
  capabilities?: Partial<CapabilityManifest>;
  /** Optional task store; defaults to in-memory. */
  taskStore?: McpTaskStore;
  /**
   * If true, `docs_search` includes the JSON schema for each tool's input.
   * Off by default because schemas inflate the bootstrap context — the
   * docstring-style description is usually enough for the executor LLM.
   */
  includeSchemas?: boolean;
  /**
   * Maximum number of tools `docs_search` returns when no filter is given.
   * Defaults to 200 — enough to cover most MCP servers without truncating.
   */
  maxDocsResults?: number;
}

/**
 * Build a code-mode MCP server. The returned `McpAgentServer` exposes the
 * two-tool surface; combine with `createFetchHandler` for HTTP transport.
 */
export function createCodeModeServer(opts: CodeModeServerOptions): McpAgentServer {
  const includeSchemas = opts.includeSchemas ?? false;
  const maxDocsResults = opts.maxDocsResults ?? 200;

  // The agent the McpAgentServer wraps is a thin adapter that dispatches to
  // either docs_search or execute_code based on the synthesised task string
  // built by `resolveTask`. We keep the agent here so the server's existing
  // tasks/elicitation machinery still works for long-running scripts.
  const agentDeps: AgentDeps = {
    tools: opts.tools,
    kernel: opts.kernel,
    includeSchemas,
    maxDocsResults,
  };
  if (opts.capabilities) agentDeps.capabilities = opts.capabilities;
  const agent = createCodeModeAgent(agentDeps);

  const serverOpts: McpAgentServerOptions = {
    serverInfo: opts.serverInfo,
    agent,
    taskStore: opts.taskStore ?? new InMemoryTaskStore(),
    tools: [
      {
        name: "docs_search",
        description:
          "Look up the available downstream tools by name or substring. " +
          "Call this BEFORE writing an execute_code script to learn what's available.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Substring to filter tool names/descriptions. Empty/omitted returns all.",
            },
            names: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional list of exact tool names to fetch. Takes precedence over `query`.",
            },
          },
        },
        resolveTask: (input) =>
          JSON.stringify({ kind: "docs_search", query: input.query, names: input.names }),
      },
      {
        name: "execute_code",
        description:
          "Run a JavaScript snippet inside a sandboxed kernel. " +
          "The snippet may call `callTool(name, args)` to invoke any downstream tool. " +
          "Only the snippet's final return value (or the value assigned to `__finalAnswer__`) " +
          "is returned to you — intermediate tool outputs stay in the sandbox. " +
          "Use this to chain many tool calls in one round.",
        inputSchema: {
          type: "object",
          required: ["code"],
          properties: {
            code: {
              type: "string",
              description:
                "JavaScript source. May use top-level `await`. Must end with a return value " +
                "or set `__finalAnswer__ = ...`.",
            },
          },
        },
        // execute_code is the long-running tool — large scripts may take many
        // seconds. The McpAgentServer will route to its Tasks API automatically
        // when sync is disabled or the host opts in.
        longRunning: true,
        resolveTask: (input) =>
          JSON.stringify({ kind: "execute_code", code: String(input.code ?? "") }),
      },
    ],
  };

  return new McpAgentServer(serverOpts);
}

// ── internals ────────────────────────────────────────────────────────────────

interface AgentDeps {
  tools: ToolRegistry;
  kernel: WasmKernel;
  capabilities?: Partial<CapabilityManifest>;
  includeSchemas: boolean;
  maxDocsResults: number;
}

/**
 * Build a `SubagentRunnable` that interprets the resolved task strings
 * produced by `resolveTask` above. The agent never calls a model — it is a
 * pure dispatch layer; the *upstream* host's model is what generates the
 * scripts. This keeps the code-mode server independent of any model adapter.
 */
function createCodeModeAgent(deps: AgentDeps): SubagentRunnable {
  return {
    async *run(task: string): AsyncGenerator<{
      traceId: string;
      parentTraceId: string | null;
      timestampMs: number;
      channel: "status";
      event: string;
      data: unknown;
    }> {
      const traceId = `codemode-${Date.now().toString(36)}`;
      const parentTraceId = null;

      let parsed: { kind: string; query?: string; names?: string[]; code?: string };
      try {
        parsed = JSON.parse(task) as typeof parsed;
      } catch {
        yield emit(traceId, parentTraceId, "error", {
          error: `code-mode: malformed task payload (${task.slice(0, 80)})`,
        });
        return;
      }

      if (parsed.kind === "docs_search") {
        const results = listToolDocs(deps, parsed.query, parsed.names);
        yield emit(traceId, parentTraceId, "final_answer", { answer: results });
        return;
      }

      if (parsed.kind === "execute_code") {
        const code = parsed.code ?? "";
        if (!code.trim()) {
          yield emit(traceId, parentTraceId, "error", { error: "code-mode: empty `code`" });
          return;
        }
        const orchestrator = new ProgrammaticOrchestrator(
          deps.kernel,
          deps.tools,
          deps.capabilities ?? {}
        );
        try {
          const result = await orchestrator.run(code);
          yield emit(traceId, parentTraceId, "final_answer", {
            answer: result.finalOutput,
            // Surfaced for trace inspection in the host's Tasks UI but NOT
            // sent back as part of the model-visible content (see
            // McpAgentServer.toContentBlocks — final_answer.answer is what
            // becomes the tool's response text).
            toolCallCount: result.toolCallCount,
          });
        } catch (err) {
          yield emit(traceId, parentTraceId, "error", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      yield emit(traceId, parentTraceId, "error", {
        error: `code-mode: unknown task kind "${parsed.kind}"`,
      });
    },
  } as SubagentRunnable;
}

function listToolDocs(
  deps: AgentDeps,
  query: string | undefined,
  names: string[] | undefined
): string {
  const all = deps.tools.list();
  const namesLower = names?.map((n) => n.toLowerCase()) ?? null;
  const q = query?.toLowerCase() ?? "";

  const filtered = all.filter((t) => {
    if (namesLower) return namesLower.includes(t.name.toLowerCase());
    if (!q) return true;
    return (
      t.name.toLowerCase().includes(q) ||
      (typeof t.description === "string" && t.description.toLowerCase().includes(q))
    );
  });

  const trimmed = filtered.slice(0, deps.maxDocsResults);
  const lines = trimmed.map((t) => {
    const head = `### ${t.name}\n${t.description ?? ""}`.trim();
    if (!deps.includeSchemas) return head;
    // includeSchemas: emit a compact JSON Schema block. Hosts that prefer
    // pasting schemas into the model's context flip this on.
    const schema =
      "inputSchema" in t && t.inputSchema
        ? `\n\`\`\`json\n${JSON.stringify(t.inputSchema, null, 2)}\n\`\`\``
        : "";
    return head + schema;
  });

  if (filtered.length > trimmed.length) {
    lines.push(
      `\n_(${filtered.length - trimmed.length} more tools omitted; pass \`names\` for exact lookup.)_`
    );
  }
  if (trimmed.length === 0) {
    return "_No matching tools._";
  }
  return lines.join("\n\n");
}

function emit(
  traceId: string,
  parentTraceId: string | null,
  event: string,
  data: unknown
): {
  traceId: string;
  parentTraceId: string | null;
  timestampMs: number;
  channel: "status";
  event: string;
  data: unknown;
} {
  return {
    traceId,
    parentTraceId,
    // We deliberately stamp 0: code-mode events are short-lived and the
    // wall-clock comes from the McpAgentServer's task record. Avoiding
    // Date.now() here also keeps the function trivially testable.
    timestampMs: 0,
    channel: "status",
    event,
    data,
  };
}
