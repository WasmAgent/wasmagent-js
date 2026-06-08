import { describe, expect, it, vi } from "vitest";

/**
 * McpToolCollection tests — mock the @modelcontextprotocol/sdk dynamic imports.
 */

function makeMockMcpClient(tools: Array<{ name: string; description?: string }> = []) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "mock result" }],
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function mockMcpSdk(client: ReturnType<typeof makeMockMcpClient>) {
  vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
    Client: vi.fn().mockImplementation(() => client),
  }));
  vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
    StdioClientTransport: vi.fn().mockImplementation(() => ({})),
  }));
  vi.doMock("@modelcontextprotocol/sdk/client/sse.js", () => ({
    SSEClientTransport: vi.fn().mockImplementation(() => ({})),
  }));
}

describe("McpToolCollection (D4)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("fromStdio: lists tools and creates ToolDefinitions", async () => {
    const mockClient = makeMockMcpClient([
      { name: "search", description: "Search the web" },
      { name: "calculator", description: "Do math" },
    ]);
    mockMcpSdk(mockClient);

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?t=" + Date.now() + ""
    );
    const collection = await MTC.fromStdio("echo", []);

    expect(collection.size).toBe(2);
    const tools = collection.list();
    expect(tools[0]?.name).toBe("search");
    expect(tools[0]?.description).toBe("Search the web");
    expect(tools[1]?.name).toBe("calculator");
  });

  it("tools are ToolDefinitions with readOnly=false, idempotent=false", async () => {
    const mockClient = makeMockMcpClient([{ name: "side-effect-tool" }]);
    mockMcpSdk(mockClient);

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?t=" + Date.now() + "2"
    );
    const collection = await MTC.fromStdio("echo", []);

    const tool = collection.list()[0]!;
    expect(tool.readOnly).toBe(false);
    expect(tool.idempotent).toBe(false);
  });

  it("forward() calls the MCP server's callTool and returns text content", async () => {
    const mockClient = makeMockMcpClient([{ name: "greet" }]);
    mockClient.callTool.mockResolvedValue({
      content: [{ type: "text", text: "Hello, world!" }],
    });
    mockMcpSdk(mockClient);

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?t=" + Date.now() + "3"
    );
    const collection = await MTC.fromStdio("echo", []);

    const tool = collection.list()[0]!;
    const result = await tool.forward({ name: "Alice" } as never);
    expect(result).toBe("Hello, world!");
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "greet",
      arguments: { name: "Alice" },
    });
  });

  it("close() disconnects from the server", async () => {
    const mockClient = makeMockMcpClient([]);
    mockMcpSdk(mockClient);

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?t=" + Date.now() + "4"
    );
    const collection = await MTC.fromStdio("echo", []);
    await collection.close();

    expect(mockClient.close).toHaveBeenCalledOnce();
  });

  it("multiple text content blocks are joined with newlines", async () => {
    const mockClient = makeMockMcpClient([{ name: "multi" }]);
    mockClient.callTool.mockResolvedValue({
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
    });
    mockMcpSdk(mockClient);

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?t=" + Date.now() + "5"
    );
    const collection = await MTC.fromStdio("echo", []);
    const tool = collection.list()[0]!;
    const result = await tool.forward({} as never);
    expect(result).toBe("line one\nline two");
  });

  it("tool with no description gets empty string description", async () => {
    const mockClient = makeMockMcpClient([{ name: "unnamed" }]);
    mockMcpSdk(mockClient);

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?t=" + Date.now() + "6"
    );
    const collection = await MTC.fromStdio("echo", []);
    const tool = collection.list()[0]!;
    expect(tool.description).toBe("");
  });

  it("fromSse: connects via SSE transport and returns same ToolDefinition shape", async () => {
    const mockClient = makeMockMcpClient([{ name: "sse-tool", description: "From SSE server" }]);
    mockMcpSdk(mockClient);

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?t=" + Date.now() + "7"
    );
    const collection = await MTC.fromSse("https://example.com/mcp/sse");

    expect(collection.size).toBe(1);
    const tool = collection.list()[0]!;
    expect(tool.name).toBe("sse-tool");
    expect(tool.description).toBe("From SSE server");
    expect(tool.readOnly).toBe(false);
    expect(tool.idempotent).toBe(false);
  });
});

import { afterEach } from "vitest";

describe("B3 — MCP supply chain integrity", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("allowedToolNames: tools in allowlist are trusted", async () => {
    const mockClient = makeMockMcpClient([
      { name: "allowed_tool", description: "Safe tool" },
      { name: "dangerous_tool", description: "Unsafe tool" },
    ]);
    mockMcpSdk(mockClient);

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?b3t1=" + Date.now() + ""
    );
    const collection = await MTC.fromStdio("echo", [], undefined, {
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
    const mockClient = makeMockMcpClient([{ name: "tool_a" }, { name: "tool_b" }]);
    mockMcpSdk(mockClient);

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?b3t2=" + Date.now() + ""
    );
    const collection = await MTC.fromStdio("echo", [], undefined, {
      allowedToolNames: [],
    });

    for (const tool of collection.list()) {
      expect(tool.trust).toBe("untrusted");
      expect(tool.needsApproval).toBe(true);
    }
  });

  it("no integrity options: all tools trusted by default", async () => {
    const mockClient = makeMockMcpClient([{ name: "t1" }, { name: "t2" }]);
    mockMcpSdk(mockClient);

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?b3t3=" + Date.now() + ""
    );
    const collection = await MTC.fromStdio("echo", []);

    for (const tool of collection.list()) {
      // trust defaults to "trusted" (undefined means trusted)
      expect(tool.trust === undefined || tool.trust === "trusted").toBe(true);
      expect(tool.needsApproval).toBeFalsy();
    }
  });

  it("fingerprint mismatch rejects connection", async () => {
    const mockClient = makeMockMcpClient([{ name: "tool_x" }]);
    mockMcpSdk(mockClient);

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?b3t4=" + Date.now() + ""
    );
    await expect(
      MTC.fromStdio("echo", [], undefined, {
        serverFingerprint: "000000000000000000000000000000000000000000000000000000000000dead",
      })
    ).rejects.toThrow(/fingerprint mismatch/i);
    expect(mockClient.close).toHaveBeenCalledOnce();
  });

  it("computeFingerprint produces consistent SHA-256", async () => {
    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?b3t5=" + Date.now() + ""
    );
    const tools = [
      { name: "b_tool", description: "B" },
      { name: "a_tool", description: "A" },
    ];
    const fp1 = await MTC.computeFingerprint(tools);
    const fp2 = await MTC.computeFingerprint([...tools].reverse());
    expect(fp1).toBe(fp2); // order-independent
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── B3: Resources and Prompts tests ──────────────────────────────────────────

describe("McpToolCollection — B3: resources and prompts", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function makeMockMcpClientWithResourcesAndPrompts() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: "search" }] }),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
      close: vi.fn().mockResolvedValue(undefined),
      listResources: vi.fn().mockResolvedValue({
        resources: [
          {
            uri: "file:///data.json",
            name: "data",
            description: "Main dataset",
            mimeType: "application/json",
          },
          { uri: "file:///config.yaml", name: "config", mimeType: "text/yaml" },
        ],
      }),
      readResource: vi.fn().mockImplementation(({ uri }: { uri: string }) =>
        Promise.resolve({
          contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ key: "value" }) }],
        })
      ),
      listPrompts: vi.fn().mockResolvedValue({
        prompts: [
          { name: "system_prompt", description: "System instructions", arguments: [] },
          { name: "user_prefix", description: "User prefix" },
        ],
      }),
      getPrompt: vi.fn().mockImplementation(({ name }: { name: string }) =>
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

  it("listResources returns all available resources", async () => {
    const mockClient = makeMockMcpClientWithResourcesAndPrompts();
    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: vi.fn().mockImplementation(() => mockClient),
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      StdioClientTransport: vi.fn().mockImplementation(() => ({})),
    }));

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?b3r1=" + Date.now() + ""
    );
    const collection = await MTC.fromStdio("echo", []);
    const resources = await collection.listResources();

    expect(resources).toHaveLength(2);
    expect(resources[0]?.uri).toBe("file:///data.json");
    expect(resources[0]?.name).toBe("data");
    expect(resources[1]?.mimeType).toBe("text/yaml");
  });

  it("readResource returns the resource contents", async () => {
    const mockClient = makeMockMcpClientWithResourcesAndPrompts();
    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: vi.fn().mockImplementation(() => mockClient),
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      StdioClientTransport: vi.fn().mockImplementation(() => ({})),
    }));

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?b3r2=" + Date.now() + ""
    );
    const collection = await MTC.fromStdio("echo", []);
    const contents = await collection.readResource("file:///data.json");

    expect(contents).toHaveLength(1);
    expect(contents[0]?.uri).toBe("file:///data.json");
    expect(JSON.parse(contents[0]?.text ?? "{}")).toEqual({ key: "value" });
  });

  it("listPrompts returns available prompts", async () => {
    const mockClient = makeMockMcpClientWithResourcesAndPrompts();
    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: vi.fn().mockImplementation(() => mockClient),
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      StdioClientTransport: vi.fn().mockImplementation(() => ({})),
    }));

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?b3p1=" + Date.now() + ""
    );
    const collection = await MTC.fromStdio("echo", []);
    const prompts = await collection.listPrompts();

    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.name).toBe("system_prompt");
  });

  it("getPrompt retrieves a named prompt", async () => {
    const mockClient = makeMockMcpClientWithResourcesAndPrompts();
    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: vi.fn().mockImplementation(() => mockClient),
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      StdioClientTransport: vi.fn().mockImplementation(() => ({})),
    }));

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?b3p2=" + Date.now() + ""
    );
    const collection = await MTC.fromStdio("echo", []);
    const result = await collection.getPrompt("system_prompt");

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
  });

  it("getPromptAsSystemPrefix extracts text from user messages", async () => {
    const mockClient = makeMockMcpClientWithResourcesAndPrompts();
    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: vi.fn().mockImplementation(() => mockClient),
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      StdioClientTransport: vi.fn().mockImplementation(() => ({})),
    }));

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?b3p3=" + Date.now() + ""
    );
    const collection = await MTC.fromStdio("echo", []);
    const prefix = await collection.getPromptAsSystemPrefix("system_prompt");

    expect(prefix).toContain("You are a helpful assistant");
    expect(prefix).toContain("system_prompt");
  });

  it("listResources throws when server does not support resources", async () => {
    const mockClientNoResources = {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      // no listResources method
    };
    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: vi.fn().mockImplementation(() => mockClientNoResources),
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      StdioClientTransport: vi.fn().mockImplementation(() => ({})),
    }));

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?b3r3=" + Date.now() + ""
    );
    const collection = await MTC.fromStdio("echo", []);

    await expect(collection.listResources()).rejects.toThrow(/resources capability/);
  });
});

// ── A1: OAuth 2.1 / McpAuthOptions ───────────────────────────────────────────

describe("A1 — McpAuthOptions / McpAuthError", () => {
  it("McpAuthError is an Error with the server URL", async () => {
    const { McpAuthError } = await import("../tools/McpToolCollection.js");
    const err = new McpAuthError("token missing", "https://api.example.com/mcp");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("McpAuthError");
    expect(err.serverUrl).toBe("https://api.example.com/mcp");
    expect(err.message).toMatch(/token missing/);
  });

  it("fromHttp passes authProvider to StreamableHTTPClientTransport when auth is provided", async () => {
    let capturedOpts: Record<string, unknown> = {};
    const mockTransport = { start: vi.fn(), close: vi.fn(), send: vi.fn() };
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: "echo_tool", description: "echo" }] }),
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: vi.fn().mockImplementation(() => mockClient),
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
      StreamableHTTPClientTransport: vi
        .fn()
        .mockImplementation((_url: URL, opts: Record<string, unknown> = {}) => {
          capturedOpts = opts;
          return mockTransport;
        }),
    }));

    const auth = {
      tokenProvider: async () => "test-token",
      resourceIndicator: "https://api.example.com/mcp",
    };
    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?a1t1=" + Date.now() + ""
    );
    await MTC.fromHttp("https://api.example.com/mcp", undefined, undefined, auth);

    expect(capturedOpts.authProvider).toBeDefined();
    const provider = capturedOpts.authProvider as Record<string, unknown>;
    expect(typeof provider.tokens).toBe("function");
    expect(typeof provider.redirectToAuthorization).toBe("function");
    expect(typeof provider.validateResourceURL).toBe("function");
  });

  it("buildOAuthProvider tokens() calls tokenProvider and returns Bearer token", async () => {
    const capturedProviders: Array<Record<string, unknown>> = [];
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: vi.fn().mockImplementation(() => mockClient),
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
      StreamableHTTPClientTransport: vi
        .fn()
        .mockImplementation((_url: URL, opts: Record<string, unknown> = {}) => {
          if (opts.authProvider)
            capturedProviders.push(opts.authProvider as Record<string, unknown>);
          return { start: vi.fn(), close: vi.fn(), send: vi.fn() };
        }),
    }));

    const tokenProvider = vi.fn().mockResolvedValue("my-access-token");
    const auth = { tokenProvider };
    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?a1t2=" + Date.now() + ""
    );
    await MTC.fromHttp("https://api.example.com/mcp", undefined, undefined, auth);

    expect(capturedProviders.length).toBeGreaterThan(0);
    const provider = capturedProviders[0]!;
    const tokens = await (provider.tokens as () => Promise<{ access_token: string } | undefined>)();
    expect(tokens?.access_token).toBe("my-access-token");
    expect(tokenProvider).toHaveBeenCalled();
  });

  it("fromHttp with no auth passes no authProvider (backward compat)", async () => {
    let capturedOpts: Record<string, unknown> = {};
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: vi.fn().mockImplementation(() => mockClient),
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
      StreamableHTTPClientTransport: vi
        .fn()
        .mockImplementation((_url: URL, opts: Record<string, unknown> = {}) => {
          capturedOpts = opts;
          return { start: vi.fn(), close: vi.fn(), send: vi.fn() };
        }),
    }));

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?a1t3=" + Date.now() + ""
    );
    await MTC.fromHttp("https://api.example.com/mcp");
    expect(capturedOpts.authProvider).toBeUndefined();
  });
});

// ── A2: URL-mode elicitation ──────────────────────────────────────────────────

describe("A2 — URL-mode elicitation", () => {
  function makeMockClientWithElicitation(
    _elicitRequestHandler: (req: Record<string, unknown>) => Promise<unknown>
  ) {
    const handlers: Record<string, (req: Record<string, unknown>) => Promise<unknown>> = {};
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: "t", description: "d" }] }),
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      setRequestHandler: vi
        .fn()
        .mockImplementation(
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

  it("form-mode elicitation receives mode='form' and returns accept", async () => {
    let receivedMode = "";
    const elicitation = vi.fn().mockImplementation(async (req: { mode: string }) => {
      receivedMode = req.mode;
      return "user-input";
    });

    const mockClient = makeMockClientWithElicitation(async () => ({}));
    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: vi.fn().mockImplementation(() => mockClient),
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      StdioClientTransport: vi.fn().mockImplementation(() => ({})),
    }));

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?a2t1=" + Date.now() + ""
    );
    await MTC.fromStdio("echo", [], undefined, undefined, elicitation);

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
    const elicitation = vi
      .fn()
      .mockImplementation(async (req: { mode: string; authorizationUrl?: string }) => {
        elicitedRequests.push(req);
        return undefined; // URL-mode should not return a value
      });

    const mockClient = makeMockClientWithElicitation(async () => ({}));
    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: vi.fn().mockImplementation(() => mockClient),
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      StdioClientTransport: vi.fn().mockImplementation(() => ({})),
    }));

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?a2t2=" + Date.now() + ""
    );
    await MTC.fromStdio("echo", [], undefined, undefined, elicitation);

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
  function makeMockClientWithSampling() {
    const handlers: Record<string, (req: Record<string, unknown>) => Promise<unknown>> = {};
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: "t", description: "d" }] }),
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      setRequestHandler: vi
        .fn()
        .mockImplementation(
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

  it("registers sampling/createMessage handler when sampling callback is provided", async () => {
    const mockClient = makeMockClientWithSampling();
    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: vi.fn().mockImplementation(() => mockClient),
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      StdioClientTransport: vi.fn().mockImplementation(() => ({})),
    }));

    const samplingCallback = vi.fn().mockResolvedValue("LLM response text");
    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?a3t1=" + Date.now() + ""
    );
    await MTC.fromStdio("echo", [], undefined, undefined, undefined, samplingCallback);

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
    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: vi.fn().mockImplementation(() => mockClient),
    }));
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      StdioClientTransport: vi.fn().mockImplementation(() => ({})),
    }));

    const { McpToolCollection: MTC } = await import(
      "../tools/McpToolCollection.js?a3t2=" + Date.now() + ""
    );
    await MTC.fromStdio("echo", []);

    await expect(
      (mockClient as ReturnType<typeof makeMockClientWithSampling>).triggerSampling({
        messages: [],
      })
    ).rejects.toThrow(/no sampling handler/);
  });
});
