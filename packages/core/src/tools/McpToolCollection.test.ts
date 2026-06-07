import { describe, it, expect, vi } from "vitest";
import { McpToolCollection } from "../tools/McpToolCollection.js";

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

    const { McpToolCollection: MTC } = await import("../tools/McpToolCollection.js?t=" + Date.now());
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

    const { McpToolCollection: MTC } = await import("../tools/McpToolCollection.js?t=" + Date.now() + "2");
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

    const { McpToolCollection: MTC } = await import("../tools/McpToolCollection.js?t=" + Date.now() + "3");
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

    const { McpToolCollection: MTC } = await import("../tools/McpToolCollection.js?t=" + Date.now() + "4");
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

    const { McpToolCollection: MTC } = await import("../tools/McpToolCollection.js?t=" + Date.now() + "5");
    const collection = await MTC.fromStdio("echo", []);
    const tool = collection.list()[0]!;
    const result = await tool.forward({} as never);
    expect(result).toBe("line one\nline two");
  });

  it("tool with no description gets empty string description", async () => {
    const mockClient = makeMockMcpClient([{ name: "unnamed" }]);
    mockMcpSdk(mockClient);

    const { McpToolCollection: MTC } = await import("../tools/McpToolCollection.js?t=" + Date.now() + "6");
    const collection = await MTC.fromStdio("echo", []);
    const tool = collection.list()[0]!;
    expect(tool.description).toBe("");
  });

  it("fromSse: connects via SSE transport and returns same ToolDefinition shape", async () => {
    const mockClient = makeMockMcpClient([
      { name: "sse-tool", description: "From SSE server" },
    ]);
    mockMcpSdk(mockClient);

    const { McpToolCollection: MTC } = await import("../tools/McpToolCollection.js?t=" + Date.now() + "7");
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

    const { McpToolCollection: MTC } = await import("../tools/McpToolCollection.js?b3t1=" + Date.now());
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
    const mockClient = makeMockMcpClient([
      { name: "tool_a" },
      { name: "tool_b" },
    ]);
    mockMcpSdk(mockClient);

    const { McpToolCollection: MTC } = await import("../tools/McpToolCollection.js?b3t2=" + Date.now());
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

    const { McpToolCollection: MTC } = await import("../tools/McpToolCollection.js?b3t3=" + Date.now());
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

    const { McpToolCollection: MTC } = await import("../tools/McpToolCollection.js?b3t4=" + Date.now());
    await expect(
      MTC.fromStdio("echo", [], undefined, {
        serverFingerprint: "000000000000000000000000000000000000000000000000000000000000dead",
      })
    ).rejects.toThrow(/fingerprint mismatch/i);
    expect(mockClient.close).toHaveBeenCalledOnce();
  });

  it("computeFingerprint produces consistent SHA-256", async () => {
    const { McpToolCollection: MTC } = await import("../tools/McpToolCollection.js?b3t5=" + Date.now());
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
