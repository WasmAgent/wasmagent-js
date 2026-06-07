import { z } from "zod";
import type { ToolDefinition } from "./types.js";

/**
 * Supply chain integrity options for MCP server connections (B3).
 *
 * Recommended security configuration for production use:
 *   - allowedToolNames: explicit allowlist of tool names to accept.
 *   - serverFingerprint: SHA-256 hex digest of the server's tool manifest.
 *   - All non-allowlisted tools are automatically marked trust:"untrusted"
 *     and needsApproval:true (human review before execution).
 */
export interface McpIntegrityOptions {
  /**
   * Allowlist of tool names to accept from the MCP server.
   * Tools NOT in this list are still registered but marked untrusted + needsApproval.
   * Set to [] (empty array) to mark ALL tools as untrusted.
   * Omit entirely (undefined) to trust all tools.
   */
  allowedToolNames?: string[];
  /**
   * Expected SHA-256 fingerprint of the sorted tool manifest JSON.
   * If provided, the connection is rejected unless the manifest matches.
   * Derive with: McpToolCollection.computeFingerprint(tools).
   */
  serverFingerprint?: string;
}

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
 *
 * With supply chain integrity (B3):
 *   const tools = await McpToolCollection.fromStdio("npx", ["-y", "@some/mcp-server"], undefined, {
 *     allowedToolNames: ["read_file", "list_dir"],
 *     serverFingerprint: "abc123...",
 *   });
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
   * @param command   - Executable to spawn (e.g. "npx", "python").
   * @param args      - Arguments passed to the executable.
   * @param env       - Optional environment variables for the subprocess.
   * @param integrity - Optional supply chain integrity options (B3).
   */
  static async fromStdio(
    command: string,
    args: string[] = [],
    env?: Record<string, string>,
    integrity?: McpIntegrityOptions
  ): Promise<McpToolCollection> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

    const transportOpts: { command: string; args: string[]; env?: Record<string, string> } = { command, args };
    if (env) transportOpts.env = env;
    const transport = new StdioClientTransport(transportOpts);
    const client = new Client({ name: "agentkit-js", version: "0.1.0" });
    await client.connect(transport);

    assertMcpClient(client);
    return McpToolCollection.#fromClient(client, integrity);
  }

  /**
   * Connect to an MCP server via SSE transport and return a ready collection.
   *
   * @deprecated SSEClientTransport is deprecated in MCP SDK ≥ 2025-03-26.
   *   Use {@link McpToolCollection.fromHttp} instead — it tries Streamable HTTP
   *   first (the current spec) and falls back to SSE for legacy servers.
   *
   * @param url       - The SSE endpoint URL.
   * @param integrity - Optional supply chain integrity options (B3).
   */
  static async fromSse(url: string, integrity?: McpIntegrityOptions): Promise<McpToolCollection> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");

    const transport = new SSEClientTransport(new URL(url));
    const client = new Client({ name: "agentkit-js", version: "0.1.0" });
    await client.connect(transport);

    assertMcpClient(client);
    return McpToolCollection.#fromClient(client, integrity);
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
   * @param url       - The MCP server endpoint URL.
   * @param integrity - Optional supply chain integrity options (B3).
   */
  static async fromHttp(url: string, integrity?: McpIntegrityOptions): Promise<McpToolCollection> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const baseUrl = new URL(url);
    const client = new Client({ name: "agentkit-js", version: "0.1.0" });

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
          `McpToolCollection.fromHttp: StreamableHTTPClientTransport not available in the ` +
            `installed @modelcontextprotocol/sdk version. ` +
            `Use fromSse() or upgrade the SDK (StreamableHTTP added in SDK ≥ 1.7.0). ` +
            `Original error: ${msg}`
        );
      }
      const connMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[mcp] Streamable HTTP failed (${connMsg}), falling back to SSE`);
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      const fallbackClient = new Client({ name: "agentkit-js", version: "0.1.0" });
      await fallbackClient.connect(new SSEClientTransport(baseUrl));
      assertMcpClient(fallbackClient);
      return McpToolCollection.#fromClient(fallbackClient, integrity);
    }

    assertMcpClient(client);
    return McpToolCollection.#fromClient(client, integrity);
  }

  static async #fromClient(
    client: McpClientInterface,
    integrity?: McpIntegrityOptions
  ): Promise<McpToolCollection> {
    const { tools: mcpTools } = await client.listTools();

    // B3: verify server fingerprint if specified.
    if (integrity?.serverFingerprint) {
      const actual = await McpToolCollection.computeFingerprint(mcpTools);
      if (actual !== integrity.serverFingerprint) {
        await client.close();
        throw new Error(
          `MCP server fingerprint mismatch.\n` +
          `  Expected: ${integrity.serverFingerprint}\n` +
          `  Actual:   ${actual}\n` +
          `The server's tool manifest has changed since the fingerprint was recorded. ` +
          `Verify the server version and update the fingerprint.`
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
    // B3: tools outside the allowlist are untrusted and require human approval.
    const isAllowed = allowedSet === null || allowedSet.has(schema.name);
    const trust = isAllowed ? ("trusted" as const) : ("untrusted" as const);

    return {
      name: schema.name,
      description: schema.description ?? "",
      inputSchema,
      ...(schema.inputSchema !== undefined ? { rawInputJsonSchema: schema.inputSchema } : {}),
      outputSchema: z.string(),
      readOnly: false,
      idempotent: false,
      trust,
      ...(!isAllowed ? { needsApproval: true as const } : {}),
      forward: async (input: Record<string, unknown>): Promise<string> => {
        const result = await client.callTool({
          name: schema.name,
          arguments: input,
        });
        return result.content
          .filter((c): c is McpTextContent => c.type === "text")
          .map((c) => c.text)
          .join("\n");
      },
    };
  }

  /**
   * B3: Compute a deterministic SHA-256 fingerprint of a tool manifest.
   * Use this to derive the expected fingerprint for `serverFingerprint` options.
   *
   * @param tools - Array of MCP tool schemas (from listTools().tools).
   * @returns Hex-encoded SHA-256 digest.
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

export interface McpToolSchema {
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
