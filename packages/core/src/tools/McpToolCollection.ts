import { z } from "zod";
import type { ToolDefinition } from "./types.js";

/**
 * MCP tool collection (D4) — wraps an MCP server's tools as agentkit ToolDefinitions.
 *
 * Uses `@modelcontextprotocol/sdk` (optional peer dependency) to connect to any
 * MCP server via stdio or SSE transport and expose its tools to agentkit agents.
 *
 * Usage:
 *   const tools = await McpToolCollection.fromStdio("npx", ["-y", "@some/mcp-server"]);
 *   const agent = new ToolCallingAgent({ tools: tools.list(), model });
 *   await tools.close();
 */
export class McpToolCollection {
  readonly #client: unknown;
  readonly #tools: ToolDefinition[];

  private constructor(client: unknown, tools: ToolDefinition[]) {
    this.#client = client;
    this.#tools = tools;
  }

  /**
   * Connect to an MCP server via stdio transport and return a ready collection.
   *
   * @param command - Executable to spawn (e.g. "npx", "python").
   * @param args    - Arguments passed to the executable.
   * @param env     - Optional environment variables for the subprocess.
   */
  static async fromStdio(
    command: string,
    args: string[] = [],
    env?: Record<string, string>
  ): Promise<McpToolCollection> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

    const transportOpts: { command: string; args: string[]; env?: Record<string, string> } = { command, args };
    if (env) transportOpts.env = env;
    const transport = new StdioClientTransport(transportOpts);
    const client = new Client({ name: "agentkit-js", version: "0.1.0" });
    await client.connect(transport);

    assertMcpClient(client);
    return McpToolCollection.#fromClient(client);
  }

  /**
   * Connect to an MCP server via SSE transport and return a ready collection.
   *
   * @deprecated SSEClientTransport is deprecated in MCP SDK ≥ 2025-03-26.
   *   Use {@link McpToolCollection.fromHttp} instead — it tries Streamable HTTP
   *   first (the current spec) and falls back to SSE for legacy servers.
   *
   * @param url - The SSE endpoint URL.
   */
  static async fromSse(url: string): Promise<McpToolCollection> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");

    const transport = new SSEClientTransport(new URL(url));
    const client = new Client({ name: "agentkit-js", version: "0.1.0" });
    await client.connect(transport);

    assertMcpClient(client);
    return McpToolCollection.#fromClient(client);
  }

  /**
   * Connect to an MCP server over HTTP, with automatic transport negotiation.
   *
   * Tries Streamable HTTP first (MCP spec ≥ 2025-03-26 / SDK ≥ 1.7.0).
   * If the server returns a 4xx or rejects the connection, falls back to the
   * deprecated SSE transport for backward compatibility with older servers.
   *
   * This is the recommended method for HTTP-based MCP servers.
   *
   * @param url - The MCP server endpoint URL.
   */
  static async fromHttp(url: string): Promise<McpToolCollection> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const baseUrl = new URL(url);
    const client = new Client({ name: "agentkit-js", version: "0.1.0" });

    try {
      const { StreamableHTTPClientTransport } =
        await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const transport = new (StreamableHTTPClientTransport as StreamableHTTPConstructor)(baseUrl);
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    } catch (err) {
      // Q4: distinguish module-not-found (SDK too old, dep missing) from connection errors.
      // A missing module means Streamable HTTP is unavailable in this SDK version —
      // re-throw instead of silently falling back to SSE (which would mask the real problem).
      // Check both error.code (Node.js module error) and message string as a fallback.
      const isModuleNotFound =
        (err instanceof Error && (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") ||
        (err instanceof Error && (err.message.includes("ERR_MODULE_NOT_FOUND") || err.message.includes("Cannot find module")));
      if (isModuleNotFound) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `McpToolCollection.fromHttp: StreamableHTTPClientTransport not available in the ` +
            `installed @modelcontextprotocol/sdk version. ` +
            `Use fromSse() or upgrade the SDK (StreamableHTTP added in SDK ≥ 1.7.0). ` +
            `Original error: ${msg}`
        );
      }
      // Connection error (4xx, network timeout, server doesn't support Streamable HTTP) →
      // fall back to SSE with a warning so the caller can see the degradation.
      const connMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[mcp] Streamable HTTP failed (${connMsg}), falling back to SSE`);
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      const fallbackClient = new Client({ name: "agentkit-js", version: "0.1.0" });
      await fallbackClient.connect(new SSEClientTransport(baseUrl));
      assertMcpClient(fallbackClient);
      return McpToolCollection.#fromClient(fallbackClient);
    }

    assertMcpClient(client);
    return McpToolCollection.#fromClient(client);
  }

  static async #fromClient(client: McpClientInterface): Promise<McpToolCollection> {
    const { tools: mcpTools } = await client.listTools();
    const tools = mcpTools.map((t) => McpToolCollection.#wrapTool(t, client));
    return new McpToolCollection(client, tools);
  }

  static #wrapTool(
    schema: McpToolSchema,
    client: McpClientInterface
  ): ToolDefinition<Record<string, unknown>, string> {
    // z.record(z.unknown()) is a passthrough validator — the MCP server validates
    // arguments on its side. The actual input schema is preserved in rawInputJsonSchema
    // so the model receives accurate field names, types, and required constraints.
    const inputSchema = z.record(z.unknown());

    return {
      name: schema.name,
      description: schema.description ?? "",
      inputSchema,
      // Pass through the MCP server's own JSON Schema so toJsonSchema() gives
      // the model accurate field definitions instead of a bare {type:"object"}.
      ...(schema.inputSchema !== undefined ? { rawInputJsonSchema: schema.inputSchema } : {}),
      outputSchema: z.string(),
      readOnly: false,   // Conservative: assume MCP tools may have side effects.
      idempotent: false,
      forward: async (input: Record<string, unknown>): Promise<string> => {
        const result = await client.callTool({
          name: schema.name,
          arguments: input,
        });
        // Concatenate all text content blocks into a single string.
        return result.content
          .filter((c): c is McpTextContent => c.type === "text")
          .map((c) => c.text)
          .join("\n");
      },
    };
  }

  /** All tools from this MCP server, ready to pass to a ToolRegistry. */
  list(): ToolDefinition[] {
    return [...this.#tools];
  }

  /**
   * L1-1: Mark all tools in this collection as deferred (deferLoading: true).
   *
   * Call this on large MCP server collections (≥10 tools) to exclude their schemas
   * from the system prompt prefix and load them on-demand via Tool Search.
   * Returns this instance for chaining.
   */
  deferAll(): this {
    for (const tool of this.#tools) {
      (tool as unknown as Record<string, unknown>)["deferLoading"] = true;
    }
    return this;
  }

  /** Number of tools available from the connected server. */
  get size(): number {
    return this.#tools.length;
  }

  /** Disconnect from the MCP server. */
  async close(): Promise<void> {
    await (this.#client as { close(): Promise<void> }).close();
  }
}

// ── MCP SDK type stubs (avoid importing types that may not be installed) ─────

/** Minimal constructor shape for StreamableHTTPClientTransport (SDK ≥ 1.7.0). */
interface StreamableHTTPConstructor {
  new(url: URL): { start(): Promise<void>; close(): Promise<void> };
}

interface McpClientInterface {
  listTools(): Promise<{ tools: McpToolSchema[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{ content: McpContent[] }>;
  close(): Promise<void>;
}

function assertMcpClient(client: unknown): asserts client is McpClientInterface {
  if (!client || typeof client !== "object") throw new Error("Invalid MCP client: expected object");
  const c = client as Record<string, unknown>;
  if (typeof c["listTools"] !== "function") throw new Error("Invalid MCP client: missing listTools()");
  if (typeof c["callTool"] !== "function") throw new Error("Invalid MCP client: missing callTool()");
  if (typeof c["close"] !== "function") throw new Error("Invalid MCP client: missing close()");
}

interface McpToolSchema {
  name: string;
  description?: string | undefined;
  inputSchema?: {
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
