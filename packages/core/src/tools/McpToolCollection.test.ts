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
