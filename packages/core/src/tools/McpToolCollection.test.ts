import { afterEach, describe, expect, it, mock } from "bun:test";
import { McpToolCollection } from "../tools/McpToolCollection.js";

/**
 * McpToolCollection tests — mock the @modelcontextprotocol/sdk modules.
 */

// ── Mutable mock state — each test sets these before calling McpToolCollection ──

let _mockClientFactory: () => any = () => defaultMockClient();

function defaultMockClient() {
  return makeMockMcpClient([]);
}

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: mock((..._args: any[]) => _mockClientFactory()),
}));
mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: mock(() => ({})),
}));
mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: mock(() => ({})),
}));
mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: mock(() => ({})),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockMcpClient(tools: Array<{ name: string; description?: string }> = []) {
  return {
    connect: mock(() => Promise.resolve(undefined)),
    listTools: mock(() => Promise.resolve({ tools })),
    callTool: mock(() =>
      Promise.resolve({
        content: [{ type: "text", text: "mock result" }],
      })
    ),
    close: mock(() => Promise.resolve(undefined)),
  };
}

function makeMockMcpClientWithResourcesAndPrompts() {
  return {
    connect: mock(() => Promise.resolve(undefined)),
    listTools: mock(() => Promise.resolve({ tools: [{ name: "search" }] })),
    callTool: mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] })),
    close: mock(() => Promise.resolve(undefined)),
    listResources: mock(() =>
      Promise.resolve({
        resources: [
          {
            uri: "file:///data.json",
            name: "data",
            description: "Main dataset",
            mimeType: "application/json",
          },
          { uri: "file:///config.yaml", name: "config", mimeType: "text/yaml" },
        ],
      })
    ),
    readResource: mock(({ uri }: { uri: string }) =>
      Promise.resolve({
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ key: "value" }) }],
      })
    ),
    listPrompts: mock(() =>
      Promise.resolve({
        prompts: [
          { name: "system_prompt", description: "System instructions", arguments: [] },
          { name: "user_prefix", description: "User prefix" },
        ],
      })
    ),
    getPrompt: mock(({ name }: { name: string }) =>
      Promise.resolve({
        description: `${name} description`,
        messages: [
          {
            role: "user",
            content: { type: "text", text: `You are a helpful assistant. (${name})` },
          },
        ],
      })
    ),
  };
}

function makeMockClientWithElicitation(
  _elicitRequestHandler: (req: Record<string, unknown>) => Promise<unknown>
) {
  const handlers: Record<string, (req: Record<string, unknown>) => Promise<unknown>> = {};
  return {
    connect: mock(() => Promise.resolve(undefined)),
    listTools: mock(() => Promise.resolve({ tools: [{ name: "t", description: "d" }] })),
    callTool: mock(() => Promise.resolve(undefined)),
    close: mock(() => Promise.resolve(undefined)),
    setRequestHandler: mock(
      (method: string, handler: (req: Record<string, unknown>) => Promise<unknown>) => {
        handlers[method] = handler;
      }
    ),
    async triggerElicitation(req: Record<string, unknown>) {
      const handler = handlers["elicitation/create"];
      if (!handler) throw new Error("no handler");
      return handler(req);
    },
  };
}

function makeMockClientWithSampling() {
  const handlers: Record<string, (req: Record<string, unknown>) => Promise<unknown>> = {};
  return {
    connect: mock(() => Promise.resolve(undefined)),
    listTools: mock(() => Promise.resolve({ tools: [{ name: "t", description: "d" }] })),
    callTool: mock(() => Promise.resolve(undefined)),
    close: mock(() => Promise.resolve(undefined)),
    setRequestHandler: mock(
      (method: string, handler: (req: Record<string, unknown>) => Promise<unknown>) => {
        handlers[method] = handler;
      }
    ),
    async triggerSampling(req: Record<string, unknown>) {
      const handler = handlers["sampling/createMessage"];
      if (!handler) throw new Error("no sampling handler registered");
      return handler(req);
    },
  };
}

// ── D4: McpToolCollection core ────────────────────────────────────────────────

describe("McpToolCollection (D4)", () => {
  afterEach(() => {
    mock.restore();
  });

  it("fromStdio: lists tools and creates ToolDefinitions", async () => {
    const client = makeMockMcpClient([
      { name: "search", description: "Search the web" },
      { name: "calculator", description: "Do math" },
    ]);
    _mockClientFactory = () => client;
    const collection = await McpToolCollection.fromStdio("echo", []);

    expect(collection.size).toBe(2);
    const tools = collection.list();
    expect(tools[0]?.name).toBe("search");
    expect(tools[0]?.description).toBe("Search the web");
    expect(tools[1]?.name).toBe("calculator");
  });

  it("tools are ToolDefinitions with readOnly=false, idempotent=false", async () => {
    const client = makeMockMcpClient([{ name: "side-effect-tool" }]);
    _mockClientFactory = () => client;
    const collection = await McpToolCollection.fromStdio("echo", []);

    const tool = collection.list()[0] as ReturnType<typeof collection.list>[number];
    expect(tool.readOnly).toBe(false);
    expect(tool.idempotent).toBe(false);
  });

  it("forward() calls the MCP server's callTool and returns text content", async () => {
    const client = makeMockMcpClient([{ name: "greet" }]);
    client.callTool = mock(() =>
      Promise.resolve({
        content: [{ type: "text", text: "Hello, world!" }],
      })
    );
    _mockClientFactory = () => client;
    const collection = await McpToolCollection.fromStdio("echo", []);

    const tool = collection.list()[0] as ReturnType<typeof collection.list>[number];
    const result = await tool.forward({ name: "Alice" } as never);
    expect(result).toBe("Hello, world!");
    expect(client.callTool).toHaveBeenCalledWith({
      name: "greet",
      arguments: { name: "Alice" },
    });
  });

  it("close() disconnects from the server", async () => {
    const client = makeMockMcpClient([]);
    _mockClientFactory = () => client;
    const collection = await McpToolCollection.fromStdio("echo", []);
    await collection.close();

    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("multiple text content blocks are joined with newlines", async () => {
    const client = makeMockMcpClient([{ name: "multi" }]);
    client.callTool = mock(() =>
      Promise.resolve({
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      })
    );
    _mockClientFactory = () => client;
    const collection = await McpToolCollection.fromStdio("echo", []);
    const tool = collection.list()[0] as ReturnType<typeof collection.list>[number];
    const result = await tool.forward({} as never);
    expect(result).toBe("line one\nline two");
  });

  it("tool with no description gets empty string description", async () => {
    const client = makeMockMcpClient([{ name: "unnamed" }]);
    _mockClientFactory = () => client;
    const collection = await McpToolCollection.fromStdio("echo", []);
    const tool = collection.list()[0] as ReturnType<typeof collection.list>[number];
    expect(tool.description).toBe("");
  });

  it("fromSse: connects via SSE transport and returns same ToolDefinition shape", async () => {
    const client = makeMockMcpClient([{ name: "sse-tool", description: "From SSE server" }]);
    _mockClientFactory = () => client;
    const collection = await McpToolCollection.fromSse("https://example.com/mcp/sse");

    expect(collection.size).toBe(1);
    const tool = collection.list()[0] as ReturnType<typeof collection.list>[number];
    expect(tool.name).toBe("sse-tool");
    expect(tool.description).toBe("From SSE server");
    expect(tool.readOnly).toBe(false);
    expect(tool.idempotent).toBe(false);
  });
});

// ── B3: MCP supply chain integrity ───────────────────────────────────────────

describe("B3 — MCP supply chain integrity", () => {
  afterEach(() => {
    mock.restore();
  });

  it("allowedToolNames: tools in allowlist are trusted", async () => {
    const client = makeMockMcpClient([
      { name: "allowed_tool", description: "Safe tool" },
      { name: "dangerous_tool", description: "Unsafe tool" },
    ]);
    _mockClientFactory = () => client;
    const collection = await McpToolCollection.fromStdio("echo", [], undefined, {
      allowedToolNames: ["allowed_tool"],
    });

    const tools = collection.list();
    const allowed = tools.find((t: { name: string }) => t.name === "allowed_tool");
    const dangerous = tools.find((t: { name: string }) => t.name === "dangerous_tool");

    expect(allowed?.trust).toBe("trusted");
    expect(dangerous?.trust).toBe("untrusted");
    expect(dangerous?.needsApproval).toBe(true);
  });

  it("empty allowedToolNames marks ALL tools as untrusted", async () => {
    const client = makeMockMcpClient([{ name: "tool_a" }, { name: "tool_b" }]);
    _mockClientFactory = () => client;
    const collection = await McpToolCollection.fromStdio("echo", [], undefined, {
      allowedToolNames: [],
    });

    for (const tool of collection.list()) {
      expect(tool.trust).toBe("untrusted");
      expect(tool.needsApproval).toBe(true);
    }
  });

  it("no integrity options: all tools trusted by default", async () => {
    const client = makeMockMcpClient([{ name: "t1" }, { name: "t2" }]);
    _mockClientFactory = () => client;
    const collection = await McpToolCollection.fromStdio("echo", []);

    for (const tool of collection.list()) {
      // trust defaults to "trusted" (undefined means trusted)
      expect(tool.trust === undefined || tool.trust === "trusted").toBe(true);
      expect(tool.needsApproval).toBeFalsy();
    }
  });

  it("fingerprint mismatch rejects connection", async () => {
    const client = makeMockMcpClient([{ name: "tool_x" }]);
    _mockClientFactory = () => client;
    await expect(
      McpToolCollection.fromStdio("echo", [], undefined, {
        serverFingerprint: "000000000000000000000000000000000000000000000000000000000000dead",
      })
    ).rejects.toThrow(/fingerprint mismatch/i);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("computeFingerprint produces consistent SHA-256", async () => {
    const tools = [
      { name: "b_tool", description: "B" },
      { name: "a_tool", description: "A" },
    ];
    const fp1 = await McpToolCollection.computeFingerprint(tools);
    const fp2 = await McpToolCollection.computeFingerprint([...tools].reverse());
    expect(fp1).toBe(fp2); // order-independent
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── B3: Resources and Prompts ─────────────────────────────────────────────────

describe("McpToolCollection — B3: resources and prompts", () => {
  afterEach(() => {
    mock.restore();
  });

  it("listResources returns all available resources", async () => {
    const client = makeMockMcpClientWithResourcesAndPrompts();
    _mockClientFactory = () => client;
    const collection = await McpToolCollection.fromStdio("echo", []);
    const resources = await collection.listResources();

    expect(resources).toHaveLength(2);
    expect(resources[0]?.uri).toBe("file:///data.json");
    expect(resources[0]?.name).toBe("data");
    expect(resources[1]?.mimeType).toBe("text/yaml");
  });

  it("readResource returns the resource contents", async () => {
    const client = makeMockMcpClientWithResourcesAndPrompts();
    _mockClientFactory = () => client;
    const collection = await McpToolCollection.fromStdio("echo", []);
    const contents = await collection.readResource("file:///data.json");

    expect(contents).toHaveLength(1);
    expect(contents[0]?.uri).toBe("file:///data.json");
    expect(JSON.parse(contents[0]?.text ?? "{}")).toEqual({ key: "value" });
  });

  it("listPrompts returns available prompts", async () => {
    const client = makeMockMcpClientWithResourcesAndPrompts();
    _mockClientFactory = () => client;
    const collection = await McpToolCollection.fromStdio("echo", []);
    const prompts = await collection.listPrompts();

    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.name).toBe("system_prompt");
  });

  it("getPrompt retrieves a named prompt", async () => {
    const client = makeMockMcpClientWithResourcesAndPrompts();
    _mockClientFactory = () => client;
    const collection = await McpToolCollection.fromStdio("echo", []);
    const result = await collection.getPrompt("system_prompt");

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
  });

  it("getPromptAsSystemPrefix extracts text from user messages", async () => {
    const client = makeMockMcpClientWithResourcesAndPrompts();
    _mockClientFactory = () => client;
    const collection = await McpToolCollection.fromStdio("echo", []);
    const prefix = await collection.getPromptAsSystemPrefix("system_prompt");

    expect(prefix).toContain("You are a helpful assistant");
    expect(prefix).toContain("system_prompt");
  });

  it("listResources throws when server does not support resources", async () => {
    const mockClientNoResources = {
      connect: mock(() => Promise.resolve(undefined)),
      listTools: mock(() => Promise.resolve({ tools: [] })),
      callTool: mock(() => Promise.resolve(undefined)),
      close: mock(() => Promise.resolve(undefined)),
      // no listResources method
    };
    _mockClientFactory = () => mockClientNoResources;
    const collection = await McpToolCollection.fromStdio("echo", []);

    await expect(collection.listResources()).rejects.toThrow(/resources capability/);
  });
});

// ── A1: OAuth 2.1 / McpAuthOptions ───────────────────────────────────────────

import { McpAuthError } from "../tools/McpToolCollection.js";

describe("A1 — McpAuthOptions / McpAuthError", () => {
  it("McpAuthError is an Error with the server URL", () => {
    const err = new McpAuthError("token missing", "https://api.example.com/mcp");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("McpAuthError");
    expect(err.serverUrl).toBe("https://api.example.com/mcp");
    expect(err.message).toMatch(/token missing/);
  });

  it("fromHttp passes authProvider to StreamableHTTPClientTransport when auth is provided", async () => {
    let capturedOpts: Record<string, unknown> = {};
    const mockTransport = {
      start: mock(() => Promise.resolve(undefined)),
      close: mock(() => Promise.resolve(undefined)),
      send: mock(() => Promise.resolve(undefined)),
    };
    const client = {
      connect: mock(() => Promise.resolve(undefined)),
      listTools: mock(() =>
        Promise.resolve({ tools: [{ name: "echo_tool", description: "echo" }] })
      ),
      callTool: mock(() => Promise.resolve(undefined)),
      close: mock(() => Promise.resolve(undefined)),
    };
    _mockClientFactory = () => client;

    // Override streamableHttp mock to capture opts
    mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
      StreamableHTTPClientTransport: mock((_url: URL, opts: Record<string, unknown> = {}) => {
        capturedOpts = opts;
        return mockTransport;
      }),
    }));

    const auth = {
      tokenProvider: async () => "test-token",
      resourceIndicator: "https://api.example.com/mcp",
    };
    await McpToolCollection.fromHttp("https://api.example.com/mcp", undefined, undefined, auth);

    expect(capturedOpts.authProvider).toBeDefined();
    const provider = capturedOpts.authProvider as Record<string, unknown>;
    expect(typeof provider.tokens).toBe("function");
    expect(typeof provider.redirectToAuthorization).toBe("function");
    expect(typeof provider.validateResourceURL).toBe("function");
  });

  it("buildOAuthProvider tokens() calls tokenProvider and returns Bearer token", async () => {
    const capturedProviders: Array<Record<string, unknown>> = [];
    const client = {
      connect: mock(() => Promise.resolve(undefined)),
      listTools: mock(() => Promise.resolve({ tools: [] })),
      callTool: mock(() => Promise.resolve(undefined)),
      close: mock(() => Promise.resolve(undefined)),
    };
    _mockClientFactory = () => client;

    mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
      StreamableHTTPClientTransport: mock((_url: URL, opts: Record<string, unknown> = {}) => {
        if (opts.authProvider) capturedProviders.push(opts.authProvider as Record<string, unknown>);
        return {
          start: mock(() => Promise.resolve(undefined)),
          close: mock(() => Promise.resolve(undefined)),
          send: mock(() => Promise.resolve(undefined)),
        };
      }),
    }));

    const tokenProvider = mock(() => Promise.resolve("my-access-token"));
    const auth = { tokenProvider };
    await McpToolCollection.fromHttp("https://api.example.com/mcp", undefined, undefined, auth);

    expect(capturedProviders.length).toBeGreaterThan(0);
    const provider = capturedProviders[0] as Record<string, unknown>;
    const tokens = await (provider.tokens as () => Promise<{ access_token: string } | undefined>)();
    expect(tokens?.access_token).toBe("my-access-token");
    expect(tokenProvider).toHaveBeenCalled();
  });

  it("fromHttp with no auth passes no authProvider (backward compat)", async () => {
    let capturedOpts: Record<string, unknown> = {};
    const client = {
      connect: mock(() => Promise.resolve(undefined)),
      listTools: mock(() => Promise.resolve({ tools: [] })),
      callTool: mock(() => Promise.resolve(undefined)),
      close: mock(() => Promise.resolve(undefined)),
    };
    _mockClientFactory = () => client;

    mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
      StreamableHTTPClientTransport: mock((_url: URL, opts: Record<string, unknown> = {}) => {
        capturedOpts = opts;
        return {
          start: mock(() => Promise.resolve(undefined)),
          close: mock(() => Promise.resolve(undefined)),
          send: mock(() => Promise.resolve(undefined)),
        };
      }),
    }));

    await McpToolCollection.fromHttp("https://api.example.com/mcp");
    expect(capturedOpts.authProvider).toBeUndefined();
  });
});

// ── A2: URL-mode elicitation ──────────────────────────────────────────────────

describe("A2 — URL-mode elicitation", () => {
  it("form-mode elicitation receives mode='form' and returns accept", async () => {
    let receivedMode = "";
    const elicitation = mock(async (req: { mode: string }) => {
      receivedMode = req.mode;
      return "user-input";
    });

    const mockClient = makeMockClientWithElicitation(async () => ({}));
    _mockClientFactory = () => mockClient;

    await McpToolCollection.fromStdio("echo", [], undefined, undefined, elicitation);

    // trigger form-mode elicitation
    const result = await (
      mockClient as ReturnType<typeof makeMockClientWithElicitation>
    ).triggerElicitation({
      message: "Enter your name",
      schema: {},
    });
    expect(receivedMode).toBe("form");
    expect((result as Record<string, string>).action).toBe("accept");
  });

  it("URL-mode elicitation receives mode='url' and returns cancel (no plaintext)", async () => {
    const elicitedRequests: Array<{ mode: string; authorizationUrl?: string }> = [];
    const elicitation = mock(async (req: { mode: string; authorizationUrl?: string }) => {
      elicitedRequests.push(req);
      return undefined; // URL-mode should not return a value
    });

    const mockClient = makeMockClientWithElicitation(async () => ({}));
    _mockClientFactory = () => mockClient;

    await McpToolCollection.fromStdio("echo", [], undefined, undefined, elicitation);

    // trigger URL-mode elicitation with requestType:"url" and authorizationUrl
    const result = await (
      mockClient as ReturnType<typeof makeMockClientWithElicitation>
    ).triggerElicitation({
      message: "Please authorize",
      requestType: "url",
      authorizationUrl: "https://auth.example.com/oauth/authorize?code=xxx",
    });
    expect(elicitedRequests[0]?.mode).toBe("url");
    expect(elicitedRequests[0]?.authorizationUrl).toBe(
      "https://auth.example.com/oauth/authorize?code=xxx"
    );
    // Even if callback returns a string for URL-mode, framework MUST return cancel
    expect((result as Record<string, string>).action).toBe("cancel");
  });
});

// ── A3: Sampling (server-initiated LLM inference) ────────────────────────────

describe("A3 — Sampling/createMessage registration", () => {
  it("registers sampling/createMessage handler when sampling callback is provided", async () => {
    const mockClient = makeMockClientWithSampling();
    _mockClientFactory = () => mockClient;

    const samplingCallback = mock(() => Promise.resolve("LLM response text"));
    await McpToolCollection.fromStdio(
      "echo",
      [],
      undefined,
      undefined,
      undefined,
      samplingCallback
    );

    // sampling handler should be registered
    const result = await (
      mockClient as ReturnType<typeof makeMockClientWithSampling>
    ).triggerSampling({
      messages: [{ role: "user", content: { type: "text", text: "hello" } }],
      systemPrompt: "You are a helper",
      maxTokens: 100,
    });

    expect(samplingCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([expect.objectContaining({ role: "user" })]),
        systemPrompt: "You are a helper",
        maxTokens: 100,
      })
    );
    expect((result as Record<string, unknown>).role).toBe("assistant");
    expect(((result as Record<string, unknown>).content as Record<string, unknown>).text).toBe(
      "LLM response text"
    );
  });

  it("does not register sampling handler when no callback provided", async () => {
    const mockClient = makeMockClientWithSampling();
    _mockClientFactory = () => mockClient;

    await McpToolCollection.fromStdio("echo", []);

    await expect(
      (mockClient as ReturnType<typeof makeMockClientWithSampling>).triggerSampling({
        messages: [],
      })
    ).rejects.toThrow(/no sampling handler/);
  });
});
