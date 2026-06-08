import { z } from "zod";
import type { ToolDefinition } from "./types.js";

/**
 * Supply chain integrity options for MCP server connections (B3).
 */
export interface McpIntegrityOptions {
  /**
   * Allowlist of tool names to accept from the MCP server.
   * Tools NOT in this list are still registered but marked untrusted + needsApproval.
   * Set to [] to mark ALL tools as untrusted. Omit to trust all tools.
   */
  allowedToolNames?: string[];
  /**
   * Expected SHA-256 fingerprint of the sorted tool manifest JSON.
   * If provided, the connection is rejected unless the manifest matches.
   */
  serverFingerprint?: string;
}

/**
 * Callback invoked when an MCP server requests user input via elicitation (C1).
 * The callback should prompt the user and return the response string.
 * Throw or return undefined to cancel the elicitation.
 */
export type ElicitationCallback = (request: McpElicitationRequest) => Promise<string | undefined>;

export interface McpElicitationRequest {
  /** Human-readable prompt from the MCP server. */
  message: string;
  /** Optional schema describing valid response values. */
  schema?: object | undefined;
}

/**
 * MCP tool collection — wraps an MCP server's tools as agentkit ToolDefinitions.
 *
 * Supports MCP spec 2025-11-25:
 *  - Streamable HTTP transport (preferred) with SSE fallback.
 *  - Structured tool output via outputSchema / structuredContent (C1).
 *  - Elicitation: server-initiated user input requests (C1).
 *  - Supply chain integrity: fingerprint + allowlist (B3).
 */
export class McpToolCollection {
  readonly #client: unknown;
  readonly #tools: ToolDefinition[];

  private constructor(client: unknown, tools: ToolDefinition[]) {
    this.#client = client;
    this.#tools = tools;
  }

  /**
   * Connect to an MCP server via stdio transport.
   */
  static async fromStdio(
    command: string,
    args: string[] = [],
    env?: Record<string, string>,
    integrity?: McpIntegrityOptions,
    elicitation?: ElicitationCallback
  ): Promise<McpToolCollection> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

    const transportOpts: { command: string; args: string[]; env?: Record<string, string> } = { command, args };
    if (env) transportOpts.env = env;
    const transport = new StdioClientTransport(transportOpts);
    const client = new Client(
      { name: "agentkit-js", version: "0.1.0" },
      elicitation ? { capabilities: { elicitation: {} } } : undefined
    );
    await client.connect(transport);
    assertMcpClient(client);
    if (elicitation) registerElicitation(client as McpClientInterface, elicitation);
    return McpToolCollection.#fromClient(client as McpClientInterface, integrity);
  }

  /**
   * @deprecated Use {@link McpToolCollection.fromHttp} instead.
   */
  static async fromSse(url: string, integrity?: McpIntegrityOptions): Promise<McpToolCollection> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    const transport = new SSEClientTransport(new URL(url));
    const client = new Client({ name: "agentkit-js", version: "0.1.0" });
    await client.connect(transport);
    assertMcpClient(client);
    return McpToolCollection.#fromClient(client as McpClientInterface, integrity);
  }

  /**
   * Connect to an MCP server over HTTP with automatic transport negotiation.
   * Tries Streamable HTTP first (MCP spec ≥ 2025-03-26), falls back to SSE.
   */
  static async fromHttp(
    url: string,
    integrity?: McpIntegrityOptions,
    elicitation?: ElicitationCallback
  ): Promise<McpToolCollection> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const baseUrl = new URL(url);
    const client = new Client(
      { name: "agentkit-js", version: "0.1.0" },
      elicitation ? { capabilities: { elicitation: {} } } : undefined
    );

    try {
      const { StreamableHTTPClientTransport } =
        await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const transport = new (StreamableHTTPClientTransport as StreamableHTTPConstructor)(baseUrl);
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    } catch (err) {
      const isModuleNotFound =
        (err instanceof Error && (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") ||
        (err instanceof Error && (err.message.includes("ERR_MODULE_NOT_FOUND") || err.message.includes("Cannot find module")));
      if (isModuleNotFound) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `McpToolCollection.fromHttp: StreamableHTTPClientTransport not available. ` +
          `Use fromSse() or upgrade @modelcontextprotocol/sdk (≥ 1.7.0). ` +
          `Original error: ${msg}`
        );
      }
      const connMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[mcp] Streamable HTTP failed (${connMsg}), falling back to SSE`);
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      const fallbackClient = new Client({ name: "agentkit-js", version: "0.1.0" });
      await fallbackClient.connect(new SSEClientTransport(baseUrl));
      assertMcpClient(fallbackClient);
      return McpToolCollection.#fromClient(fallbackClient as McpClientInterface, integrity);
    }

    assertMcpClient(client);
    if (elicitation) registerElicitation(client as McpClientInterface, elicitation);
    return McpToolCollection.#fromClient(client as McpClientInterface, integrity);
  }

  static async #fromClient(
    client: McpClientInterface,
    integrity?: McpIntegrityOptions
  ): Promise<McpToolCollection> {
    const { tools: mcpTools } = await client.listTools();

    if (integrity?.serverFingerprint) {
      const actual = await McpToolCollection.computeFingerprint(mcpTools);
      if (actual !== integrity.serverFingerprint) {
        await client.close();
        throw new Error(
          `MCP server fingerprint mismatch.\n` +
          `  Expected: ${integrity.serverFingerprint}\n` +
          `  Actual:   ${actual}\n` +
          `The server's tool manifest has changed since the fingerprint was recorded.`
        );
      }
    }

    const allowedSet = integrity?.allowedToolNames !== undefined
      ? new Set(integrity.allowedToolNames)
      : null;

    const tools = mcpTools.map((t) => McpToolCollection.#wrapTool(t, client, allowedSet));
    return new McpToolCollection(client, tools);
  }

  static #wrapTool(
    schema: McpToolSchema,
    client: McpClientInterface,
    allowedSet: Set<string> | null
  ): ToolDefinition<Record<string, unknown>, string> {
    const inputSchema = z.record(z.unknown());
    const isAllowed = allowedSet === null || allowedSet.has(schema.name);
    const trust = isAllowed ? ("trusted" as const) : ("untrusted" as const);

    return {
      name: schema.name,
      description: schema.description ?? "",
      inputSchema,
      ...(schema.inputSchema !== undefined ? { rawInputJsonSchema: schema.inputSchema } : {}),
      ...(schema.outputSchema !== undefined ? { rawOutputJsonSchema: schema.outputSchema } : {}),
      outputSchema: z.string(),
      readOnly: false,
      idempotent: false,
      trust,
      ...(!isAllowed ? { needsApproval: true as const } : {}),
      forward: async (input: Record<string, unknown>): Promise<string> => {
        const result = await client.callTool({ name: schema.name, arguments: input });
        const text = result.content
          .filter((c): c is McpTextContent => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        if (result.isError) {
          throw new Error(text || "MCP tool returned an error");
        }
        // C1: prefer structured content when the server returns outputSchema-typed results.
        if (result.structuredContent !== undefined) {
          return JSON.stringify(result.structuredContent);
        }
        return text;
      },
    };
  }

  /**
   * Compute a deterministic SHA-256 fingerprint of a tool manifest (B3).
   */
  static async computeFingerprint(tools: McpToolSchema[]): Promise<string> {
    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    const manifest = JSON.stringify(sorted.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? null,
    })));
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(manifest).digest("hex");
  }

  /** All tools from this MCP server. */
  list(): ToolDefinition[] {
    return [...this.#tools];
  }

  /**
   * Mark all tools as deferred (deferLoading: true) for lazy schema loading (L1-1).
   */
  deferAll(): this {
    for (const tool of this.#tools) {
      (tool as unknown as Record<string, unknown>)["deferLoading"] = true;
    }
    return this;
  }

  get size(): number { return this.#tools.length; }

  async close(): Promise<void> {
    await (this.#client as { close(): Promise<void> }).close();
  }
}

// ── Elicitation registration (C1) ────────────────────────────────────────────

function registerElicitation(client: McpClientInterface, callback: ElicitationCallback): void {
  const c = client as unknown as Record<string, unknown>;
  if (typeof c["setRequestHandler"] !== "function") return;
  try {
    (c["setRequestHandler"] as (method: string, handler: (req: Record<string, unknown>) => Promise<unknown>) => void)(
      "elicitation/create",
      async (req: Record<string, unknown>) => {
        const message = (req["message"] as string | undefined) ?? "";
        const schema = req["schema"] as object | undefined;
        const response = await callback({ message, schema });
        if (response === undefined) {
          return { action: "cancel" };
        }
        return { action: "accept", content: [{ type: "text", text: response }] };
      }
    );
  } catch {
    // SDK version may not support setRequestHandler — elicitation gracefully degraded.
  }
}

// ── MCP SDK type stubs ───────────────────────────────────────────────────────

interface StreamableHTTPConstructor {
  new(url: URL): { start(): Promise<void>; close(): Promise<void> };
}

interface McpClientInterface {
  listTools(): Promise<{ tools: McpToolSchema[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{
    content: McpContent[];
    structuredContent?: unknown;
    isError?: boolean;
  }>;
  close(): Promise<void>;
}

function assertMcpClient(client: unknown): asserts client is McpClientInterface {
  if (!client || typeof client !== "object") throw new Error("Invalid MCP client: expected object");
  const c = client as Record<string, unknown>;
  if (typeof c["listTools"] !== "function") throw new Error("Invalid MCP client: missing listTools()");
  if (typeof c["callTool"] !== "function") throw new Error("Invalid MCP client: missing callTool()");
  if (typeof c["close"] !== "function") throw new Error("Invalid MCP client: missing close()");
}

export interface McpToolSchema {
  name: string;
  description?: string | undefined;
  inputSchema?: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  /** C1: MCP 2025-06-18+ structured output schema. */
  outputSchema?: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface McpTextContent {
  type: "text";
  text: string;
}

type McpContent = McpTextContent | { type: string };
