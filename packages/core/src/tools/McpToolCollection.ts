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

    return McpToolCollection.#fromClient(client as unknown as McpClientInterface);
  }

  /**
   * Connect to an MCP server via SSE transport and return a ready collection.
   *
   * @param url - The SSE endpoint URL.
   */
  static async fromSse(url: string): Promise<McpToolCollection> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");

    const transport = new SSEClientTransport(new URL(url));
    const client = new Client({ name: "agentkit-js", version: "0.1.0" });
    await client.connect(transport);

    return McpToolCollection.#fromClient(client as unknown as McpClientInterface);
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
    // Convert MCP JSON Schema to a Zod schema for validation.
    // We use z.record(z.unknown()) as a passthrough since MCP tools have their
    // own validation on the server side.
    const inputSchema = z.record(z.unknown());

    return {
      name: schema.name,
      description: schema.description ?? "",
      inputSchema,
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

interface McpClientInterface {
  listTools(): Promise<{ tools: McpToolSchema[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{ content: McpContent[] }>;
  close(): Promise<void>;
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
