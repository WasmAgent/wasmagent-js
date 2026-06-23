# WasmAgent Runtime with Claude Agent SDK

The `@wasmagent/claude-agent-sdk` adapter produces a tool in the shape
Anthropic's Claude Agent SDK expects — `{ name, description, input_schema,
handler }`. Hand it to the SDK as a tool; the handler runs user-provided code
in a sandboxed WasmAgent kernel rather than directly in your process.

## Install

```bash
npm install @wasmagent/claude-agent-sdk @wasmagent/kernel-quickjs \
  @anthropic-ai/sdk \
  quickjs-emscripten @jitl/quickjs-wasmfile-release-sync
```

The `@anthropic-ai/sdk` peer dep is optional — the adapter only emits the
tool's structural shape, so it also works with Bedrock or Vertex transports
that consume the same `{name, description, input_schema, handler}` quadruple.

## 10-line integration

```js
import { sandboxedJsClaudeTool } from "@wasmagent/claude-agent-sdk";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const tool = sandboxedJsClaudeTool({
  kernel: new QuickJSKernel(),
  capabilities: { cpuMs: 3000 },
});

// Invoke directly (no API key needed to test the handler itself):
console.log("Tool name:", tool.name);
const result = await tool.handler({ code: "[1,2,3].map(x => x * x)" });
console.log("Handler result:", result);
```

## Wire into the Claude Agent SDK

```js
import Anthropic from "@anthropic-ai/sdk";
import { sandboxedJsClaudeTool } from "@wasmagent/claude-agent-sdk";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const tool = sandboxedJsClaudeTool({
  kernel: new QuickJSKernel(),
  capabilities: {
    allowedHosts: [],
    cpuMs: 5000,
    memoryLimitBytes: 64 * 1024 * 1024,
  },
});

const client = new Anthropic();
const turn = await client.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 512,
  tools: [{ name: tool.name, description: tool.description, input_schema: tool.input_schema }],
  messages: [{ role: "user", content: "What is the cube of 17?" }],
});

// Handle tool_use blocks:
for (const block of turn.content) {
  if (block.type === "tool_use" && block.name === tool.name) {
    const result = await tool.handler(block.input);
    // Feed result back to the SDK as a tool_result content block.
    console.log("Sandbox output:", result.output);
  }
}
```

Set `ANTHROPIC_API_KEY` in your environment before running.

## Code-mode variant

When Claude needs to chain many registered tools, use `codeModeClaudeTool`
instead. Claude sees one `execute_code` tool; its snippet calls
`callTool(name, args)` against any registered tool. At N=30 tools this cuts
prompt-bootstrap tokens by ~86%.

```js
import { codeModeClaudeTool } from "@wasmagent/claude-agent-sdk";
import { ToolRegistry } from "@wasmagent/core";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const reg = new ToolRegistry();
reg.register({ name: "search_docs", /* … */ });
reg.register({ name: "read_file", /* … */ });

const tool = codeModeClaudeTool({ kernel: new QuickJSKernel(), tools: reg });
// Claude only sees `execute_code`. Scripts may call callTool("search_docs", {...}).
```

## What is enforced

- **Sandboxed JS execution** — code runs in QuickJS, isolated from the host
  process and `process.env`.
- **CPU timeout** — `cpuMs` caps wall-clock execution.
- **Memory limit** — `memoryLimitBytes` caps the QuickJS heap (default 64 MB).

## Capability manifest example

```js
{
  allowedHosts: ["api.example.com"], // outbound fetch whitelist (deny all = [])
  allowedReadPaths: ["/workspace"],
  allowedWritePaths: [],
  cpuMs: 5000,
  memoryLimitBytes: 64 * 1024 * 1024,
}
```

## When to use which tool

| Scenario | Tool |
|---|---|
| One-shot snippet (math, JSON wrangling) | `sandboxedJsClaudeTool` |
| Claude must chain 3+ registered tools | `codeModeClaudeTool` |
| Edge / Worker environment (no node:vm) | Either, with `QuickJSKernel` |
| Multi-tenant / untrusted code | Either, with `RemoteSandboxKernel` |

## Run

```bash
node index.mjs
```

## See also

- Full integration guide: [`docs/guides/integrate-claude-agent-sdk.md`](../guides/integrate-claude-agent-sdk.md)
- Code mode deep dive: [`docs/guides/code-mode.md`](../guides/code-mode.md)
- Kernel decision tree: [`docs/kernels/comparison.md`](../kernels/comparison.md)
- Runnable example: [`examples/recipes/claude-agent-sdk/index.mjs`](../../examples/recipes/claude-agent-sdk/index.mjs)
