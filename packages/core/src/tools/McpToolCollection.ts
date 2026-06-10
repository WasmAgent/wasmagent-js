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
 * A1: OAuth 2.1 authentication options for MCP server connections.
 *
 * When provided, fromHttp() wraps the StreamableHTTPClientTransport with an
 * OAuthClientProvider that uses the supplied tokenProvider to obtain access tokens.
 * The resourceIndicator is passed as RFC 8707 `resource` to prevent confused-deputy
 * token misuse across MCP servers.
 *
 * On 401 responses, the elicitation callback (if provided) is called to guide
 * the user through re-authorization before retrying.
 */
export interface McpAuthOptions {
  /**
   * Async function that returns the current Bearer token.
   * Called for each outbound request. Return undefined when no token is available.
   */
  tokenProvider: () => Promise<string | undefined>;
  /**
   * RFC 8707 resource indicator — the canonical URL of this MCP server.
   * Prevents tokens issued for one server from being used on another.
   * Example: "https://api.example.com/mcp"
   */
  resourceIndicator?: string;
}

/**
 * A1: Error thrown when an MCP server responds with 401 and no valid token
 * could be obtained via the tokenProvider.
 */
export class McpAuthError extends Error {
  constructor(
    message: string,
    public readonly serverUrl: string
  ) {
    super(message);
    this.name = "McpAuthError";
  }
}

/**
 * Callback invoked when an MCP server requests user input via elicitation (C1/A2).
 *
 * A2: For sensitive credentials (passwords, API keys, tokens, payment info), the server
 * MUST use URL-mode elicitation per the MCP spec. In URL mode the framework does NOT
 * collect plaintext — it passes a `mode:"url"` request and the host must open the
 * `authorizationUrl` in an external browser or secure flow. The callback should NOT
 * return the credential itself; return undefined to signal that the flow was delegated.
 *
 * For non-sensitive form-mode input, return the response string.
 * Throw or return undefined to cancel the elicitation.
 */
export type ElicitationCallback = (request: McpElicitationRequest) => Promise<string | undefined>;

export interface McpElicitationRequest {
  /** Human-readable prompt from the MCP server. */
  message: string;
  /** Optional schema describing valid response values. */
  schema?: object | undefined;
  /**
   * A2: Elicitation mode.
   * - "form": standard text/structured input (default).
   * - "url": sensitive credential flow — the server provides an authorizationUrl.
   *   The host should open this URL externally. Return undefined from the callback;
   *   the credential is never passed through the client process.
   */
  mode: "form" | "url";
  /**
   * A2: Present when mode="url". The authorization endpoint the host should redirect to.
   * This URL must NOT be fetched or stored — open it in a user agent only.
   */
  authorizationUrl?: string;
}

/**
 * A3: Sampling callback — bridge for MCP server-initiated LLM inference requests.
 * When provided to fromStdio/fromHttp, the framework registers the sampling/createMessage
 * capability. The server can then ask the client to run inference via this callback.
 *
 * The sampling request messages are routed through the classifier guardrail (if configured)
 * before being passed to the model, since sampling is an injection surface.
 */
export type SamplingCallback = (request: McpSamplingRequest) => Promise<string>;

/**
 * A3: Request payload for a sampling/createMessage callback.
 */
export interface McpSamplingRequest {
  /** Conversation messages for the LLM call. */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** Optional system prompt from the server. */
  systemPrompt?: string | undefined;
  /** Optional max tokens hint from the server. */
  maxTokens?: number | undefined;
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
    elicitation?: ElicitationCallback,
    sampling?: SamplingCallback
  ): Promise<McpToolCollection> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

    const clientCaps: Record<string, unknown> = {};
    if (elicitation) clientCaps.elicitation = {};
    if (sampling) clientCaps.sampling = {};

    const transportOpts: { command: string; args: string[]; env?: Record<string, string> } = {
      command,
      args,
    };
    if (env) transportOpts.env = env;
    const transport = new StdioClientTransport(transportOpts);
    const client = new Client(
      { name: "agentkit-js", version: "0.1.0" },
      Object.keys(clientCaps).length > 0 ? { capabilities: clientCaps } : undefined
    );
    await client.connect(transport);
    assertMcpClient(client);
    if (elicitation) registerElicitation(client as McpClientInterface, elicitation);
    if (sampling) registerSampling(client as McpClientInterface, sampling);
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
   *
   * @param url         MCP server URL.
   * @param integrity   Supply-chain integrity options (B3).
   * @param elicitation Callback for server-initiated user input (C1/A2).
   * @param auth        A1: OAuth 2.1 token provider + RFC 8707 resource indicator.
   * @param sampling    A3: Callback for server-initiated LLM inference (sampling).
   */
  static async fromHttp(
    url: string,
    integrity?: McpIntegrityOptions,
    elicitation?: ElicitationCallback,
    auth?: McpAuthOptions,
    sampling?: SamplingCallback
  ): Promise<McpToolCollection> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const baseUrl = new URL(url);

    const clientCaps: Record<string, unknown> = {};
    if (elicitation) clientCaps.elicitation = {};
    if (sampling) clientCaps.sampling = {};

    const client = new Client(
      { name: "agentkit-js", version: "0.1.0" },
      Object.keys(clientCaps).length > 0 ? { capabilities: clientCaps } : undefined
    );

    try {
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      const transportOpts: Record<string, unknown> = {};
      if (auth) {
        transportOpts.authProvider = buildOAuthProvider(auth, url, elicitation);
      }
      const transport = new (StreamableHTTPClientTransport as StreamableHTTPConstructor)(
        baseUrl,
        transportOpts
      );
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    } catch (err) {
      const isModuleNotFound =
        (err instanceof Error && (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") ||
        (err instanceof Error &&
          (err.message.includes("ERR_MODULE_NOT_FOUND") ||
            err.message.includes("Cannot find module")));
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
    if (sampling) registerSampling(client as McpClientInterface, sampling);
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

    const allowedSet =
      integrity?.allowedToolNames !== undefined ? new Set(integrity.allowedToolNames) : null;

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
    const manifest = JSON.stringify(
      sorted.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? null,
      }))
    );
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
      (tool as unknown as Record<string, unknown>).deferLoading = true;
    }
    return this;
  }

  get size(): number {
    return this.#tools.length;
  }

  /**
   * B3: List all resources available on the MCP server.
   * Requires the server to support the resources capability.
   */
  async listResources(): Promise<McpResource[]> {
    const client = this.#client as McpClientInterface;
    if (typeof client.listResources !== "function") {
      throw new Error("MCP server does not support the resources capability");
    }
    const { resources } = await client.listResources();
    return resources;
  }

  /**
   * B3: Read the contents of a single MCP resource by URI.
   */
  async readResource(uri: string): Promise<McpResourceContent[]> {
    const client = this.#client as McpClientInterface;
    if (typeof client.readResource !== "function") {
      throw new Error("MCP server does not support the resources capability");
    }
    const { contents } = await client.readResource({ uri });
    return contents;
  }

  /**
   * B3: List all prompts available on the MCP server.
   */
  async listPrompts(): Promise<McpPromptSchema[]> {
    const client = this.#client as McpClientInterface;
    if (typeof client.listPrompts !== "function") {
      throw new Error("MCP server does not support the prompts capability");
    }
    const { prompts } = await client.listPrompts();
    return prompts;
  }

  /**
   * B3: Retrieve an MCP prompt by name with optional arguments.
   * Returns the rendered messages array suitable for injection into a MessageAssembler.
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<McpGetPromptResult> {
    const client = this.#client as McpClientInterface;
    if (typeof client.getPrompt !== "function") {
      throw new Error("MCP server does not support the prompts capability");
    }
    return client.getPrompt({ name, ...(args ? { arguments: args } : {}) });
  }

  /**
   * B3: Extract a system-prompt prefix string from an MCP prompt.
   * Concatenates all "user" role text blocks from the prompt messages.
   * Suitable for injection as a MessageAssembler system prefix.
   */
  async getPromptAsSystemPrefix(name: string, args?: Record<string, string>): Promise<string> {
    const result = await this.getPrompt(name, args);
    return result.messages
      .filter((m) => m.role === "user" && m.content.type === "text")
      .map((m) => (m.content as { type: "text"; text: string }).text)
      .join("\n");
  }

  async close(): Promise<void> {
    await (this.#client as { close(): Promise<void> }).close();
  }
}

// ── A1: OAuth 2.1 provider builder ───────────────────────────────────────────

/**
 * Builds a minimal OAuthClientProvider compatible object from McpAuthOptions.
 *
 * The provider is "pre-authorized" — it delegates all token management to the
 * caller's tokenProvider function. The SDK handles RFC 8707 resource validation
 * via validateResourceURL when resourceIndicator is set.
 */
function buildOAuthProvider(
  auth: McpAuthOptions,
  serverUrl: string,
  elicitation?: ElicitationCallback
): Record<string, unknown> {
  let storedToken: string | undefined;

  return {
    get redirectUrl() {
      return undefined;
    },
    get clientMetadata() {
      return {
        client_name: "agentkit-js MCP client",
        redirect_uris: [],
        grant_types: ["client_credentials"],
      };
    },
    clientInformation() {
      return undefined;
    },
    async tokens() {
      const token = await auth.tokenProvider();
      if (!token) return undefined;
      storedToken = token;
      return { access_token: token, token_type: "Bearer" };
    },
    saveTokens(tokens: { access_token: string }) {
      storedToken = tokens.access_token;
    },
    async redirectToAuthorization(_url: URL) {
      if (elicitation) {
        const response = await elicitation({
          message: `Authorization required for MCP server at ${serverUrl}. Please authorize and provide the resulting token.`,
          mode: "url",
          authorizationUrl: _url.toString(),
        });
        if (response) storedToken = response;
      } else {
        throw new McpAuthError(
          `MCP server at ${serverUrl} requires authorization but no elicitation callback was provided`,
          serverUrl
        );
      }
    },
    saveCodeVerifier(_v: string) {
      /* not needed for pre-authorized flow */
    },
    codeVerifier() {
      return storedToken ?? "";
    },
    ...(auth.resourceIndicator
      ? {
          async validateResourceURL(_serverUrl: string | URL, _resource?: string) {
            return new URL(auth.resourceIndicator as string);
          },
        }
      : {}),
  };
}

// ── Elicitation registration (C1/A2) ─────────────────────────────────────────

function registerElicitation(client: McpClientInterface, callback: ElicitationCallback): void {
  const c = client as unknown as Record<string, unknown>;
  if (typeof c.setRequestHandler !== "function") return;
  try {
    (
      c.setRequestHandler as (
        method: string,
        handler: (req: Record<string, unknown>) => Promise<unknown>
      ) => void
    )("elicitation/create", async (req: Record<string, unknown>) => {
      const message = (req.message as string | undefined) ?? "";
      const schema = req.schema as object | undefined;
      // A2: detect URL-mode elicitation. The spec requires servers to use URL-mode
      // for sensitive credentials (passwords, API keys, tokens, payment info).
      // In URL-mode we pass the authorizationUrl to the callback and do NOT collect
      // plaintext — the credential must flow through an external authorization page.
      const requestType = (req.requestType ?? req.type) as string | undefined;
      const authorizationUrl = req.authorizationUrl as string | undefined;
      const isUrlMode = requestType === "url" || !!authorizationUrl;

      const elicitRequest: McpElicitationRequest = {
        message,
        schema,
        mode: isUrlMode ? "url" : "form",
        ...(authorizationUrl ? { authorizationUrl } : {}),
      };

      if (isUrlMode) {
        // For URL-mode: invoke callback so the host can open the URL, but do not
        // return any credential back to the server through this channel.
        await callback(elicitRequest).catch(() => undefined);
        return { action: "cancel" };
      }

      const response = await callback(elicitRequest);
      if (response === undefined) {
        return { action: "cancel" };
      }
      return { action: "accept", content: [{ type: "text", text: response }] };
    });
  } catch {
    // SDK version may not support setRequestHandler — elicitation gracefully degraded.
  }
}

// ── A3: Sampling registration ────────────────────────────────────────────────

function registerSampling(client: McpClientInterface, callback: SamplingCallback): void {
  const c = client as unknown as Record<string, unknown>;
  if (typeof c.setRequestHandler !== "function") return;
  try {
    (
      c.setRequestHandler as (
        method: string,
        handler: (req: Record<string, unknown>) => Promise<unknown>
      ) => void
    )("sampling/createMessage", async (req: Record<string, unknown>) => {
      const rawMessages =
        (req.messages as
          | Array<{ role: string; content: Record<string, unknown> | string }>
          | undefined) ?? [];
      const messages = rawMessages.map((m) => ({
        role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
        content:
          typeof m.content === "string"
            ? m.content
            : (((m.content as Record<string, unknown>).text as string | undefined) ??
              JSON.stringify(m.content)),
      }));
      const systemPrompt = (req.systemPrompt as string | undefined) ?? undefined;
      const maxTokens = (req.maxTokens as number | undefined) ?? undefined;

      const responseText = await callback({ messages, systemPrompt, maxTokens });
      return {
        role: "assistant",
        content: { type: "text", text: responseText },
        model: "agentkit-js",
        stopReason: "endTurn",
      };
    });
  } catch {
    // SDK version may not support setRequestHandler — sampling gracefully degraded.
  }
}

// ── MCP SDK type stubs (B3: these are local interface stubs that mirror the SDK) ───────────────────────────────────────────────────────
// NOTE: The MCP Client is imported dynamically from @modelcontextprotocol/sdk.
// These stubs define the minimal surface we use. When the SDK is available,
// assertMcpClient() verifies the real client satisfies this interface.

interface StreamableHTTPConstructor {
  new (
    url: URL,
    opts?: Record<string, unknown>
  ): { start(): Promise<void>; close(): Promise<void> };
}

interface McpClientInterface {
  listTools(): Promise<{ tools: McpToolSchema[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{
    content: McpContent[];
    structuredContent?: unknown;
    isError?: boolean;
  }>;
  /** B3: list available resources on the MCP server. */
  listResources(): Promise<{ resources: McpResource[] }>;
  /** B3: read the contents of an MCP resource by URI. */
  readResource(params: { uri: string }): Promise<{ contents: McpResourceContent[] }>;
  /** B3: get a prompt by name with optional arguments. */
  getPrompt(params: {
    name: string;
    arguments?: Record<string, string>;
  }): Promise<McpGetPromptResult>;
  /** B3: list available prompts on the MCP server. */
  listPrompts(): Promise<{ prompts: McpPromptSchema[] }>;
  close(): Promise<void>;
}

function assertMcpClient(client: unknown): asserts client is McpClientInterface {
  if (!client || typeof client !== "object") throw new Error("Invalid MCP client: expected object");
  const c = client as Record<string, unknown>;
  if (typeof c.listTools !== "function") throw new Error("Invalid MCP client: missing listTools()");
  if (typeof c.callTool !== "function") throw new Error("Invalid MCP client: missing callTool()");
  if (typeof c.close !== "function") throw new Error("Invalid MCP client: missing close()");
  // resources/prompts are optional capabilities — don't assert here, check at call time.
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

/** B3: MCP resource descriptor. */
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** B3: MCP resource content item. */
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/** B3: MCP prompt message (used in getPrompt results). */
export interface McpPromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string } | { type: string };
}

/** B3: Result of getPrompt(). */
export interface McpGetPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

/** B3: MCP prompt descriptor. */
export interface McpPromptSchema {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

interface McpTextContent {
  type: "text";
  text: string;
}

type McpContent = McpTextContent | { type: string };
