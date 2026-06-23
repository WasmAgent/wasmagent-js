# WasmAgent Runtime with OpenAI Agents JS SDK

The `@wasmagent/openai-agents` adapter produces tools in the shape the
OpenAI Agents JS SDK expects — a `Tool` object with `name`, `description`,
`parameters`, and `execute`. The execute handler is a sandboxed WasmAgent
kernel run, so model-generated code cannot escape the sandbox.

## Install

```bash
npm install @wasmagent/openai-agents @wasmagent/kernel-quickjs \
  @openai/agents \
  quickjs-emscripten @jitl/quickjs-wasmfile-release-sync
```

## 10-line integration

```js
import { sandboxedJsAgentTool } from "@wasmagent/openai-agents";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const tool = sandboxedJsAgentTool({
  kernel: new QuickJSKernel(),
  capabilities: { cpuMs: 3000 },
});

// Invoke directly (no API key needed to test the tool itself):
console.log("Tool name:", tool.name);
const out = await tool.execute({ code: "'hello-from-quickjs'" });
console.log("Execute result:", out);
```

## Wire into an OpenAI Agent

```js
import { Agent } from "@openai/agents";
import { sandboxedJsAgentTool } from "@wasmagent/openai-agents";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const sandboxed = sandboxedJsAgentTool({
  kernel: new QuickJSKernel(),
  capabilities: {
    allowedHosts: [],
    cpuMs: 5000,
    memoryLimitBytes: 64 * 1024 * 1024,
  },
});

const agent = new Agent({
  name: "math-helper",
  instructions: "Use the sandboxed_js tool for any computation.",
  tools: [sandboxed],
});

const turn = await agent.run("What is the cube of 17?");
console.log(turn.finalOutput);
```

Set `OPENAI_API_KEY` in your environment before running.

## Code-mode variant

When your agent needs to chain many registered tools, use `codeModeAgentTool`
instead. The model sees one `execute_code` tool instead of N tools, cutting
prompt-bootstrap tokens by up to 86% at N=30.

```js
import { codeModeAgentTool } from "@wasmagent/openai-agents";
import { ToolRegistry } from "@wasmagent/core";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const reg = new ToolRegistry();
reg.register({ name: "search_docs", /* … */ });
reg.register({ name: "read_file", /* … */ });

const codeMode = codeModeAgentTool({ kernel: new QuickJSKernel(), tools: reg });

const agent = new Agent({
  name: "workflow-runner",
  instructions: "Use execute_code to chain registered tools.",
  tools: [codeMode],
});
```

## What is enforced

- **Sandboxed JS execution** — code runs in QuickJS, isolated from the host
  process.
- **CPU timeout** — `cpuMs` caps wall-clock execution.
- **Memory limit** — `memoryLimitBytes` caps the QuickJS heap.

## Capability manifest example

```js
{
  allowedHosts: ["api.example.com"], // outbound fetch whitelist
  allowedReadPaths: ["/workspace"],
  allowedWritePaths: [],
  cpuMs: 5000,
  memoryLimitBytes: 64 * 1024 * 1024,
}
```

## When to use which tool

| Scenario | Tool |
|---|---|
| One-shot snippet (math, JSON wrangling) | `sandboxedJsAgentTool` |
| Model must chain 3+ registered tools | `codeModeAgentTool` |
| Edge / Worker environment | Either, with `QuickJSKernel` |
| Multi-tenant / untrusted code | Either, with `RemoteSandboxKernel` |

## Run

```bash
node index.mjs
```

## See also

- Full integration guide: [`docs/guides/integrate-openai-agents.md`](../guides/integrate-openai-agents.md)
- Code mode deep dive: [`docs/guides/code-mode.md`](../guides/code-mode.md)
- Kernel decision tree: [`docs/kernels/comparison.md`](../kernels/comparison.md)
- Runnable example: [`examples/recipes/openai-agents/index.mjs`](../../examples/recipes/openai-agents/index.mjs)
