# Use agentkit kernels with the Claude Agent SDK

> Last refreshed: **2026-06-12**.
> Companion to [`integrate-vercel-ai-sdk.md`](integrate-vercel-ai-sdk.md)
> and [`integrate-openai-agents.md`](integrate-openai-agents.md).

Anthropic's Claude Agent SDK runs an agent loop against
`claude-{haiku|sonnet|opus}-*`, executing user-defined tools when the
model emits `tool_use` blocks. The default tool execution path runs
your handler directly — same trust boundary your service has. When
the LLM is generating the code that runs (math, JSON wrangling, a
multi-step workflow), that boundary is too loose.

`@agentkit-js/claude-agent-sdk` gives you two factories that produce
Claude Agent SDK tools whose handler is a sandboxed kernel:

- **`sandboxedJsClaudeTool`** — one-shot JS evaluator.
- **`codeModeClaudeTool`** — code-mode tool (one tool surface, N
  callable downstream tools); see
  [`code-mode.md`](code-mode.md) for the bigger picture.

Both honour the unified `CapabilityManifest`, so the policy you
already wrote for `@agentkit-js/mcp-server` applies verbatim — see
[`docs/strategy/security-face.md`](../strategy/security-face.md).

## Install

```bash
npm add @agentkit-js/claude-agent-sdk @agentkit-js/core @agentkit-js/kernel-quickjs @anthropic-ai/sdk
```

The `@anthropic-ai/sdk` peer dep is declared *optional* — the
adapter only emits the tool's structural shape, so you can also
plug it into a Bedrock or Vertex transport that consumes the same
`{name, description, input_schema, handler}` quadruple.

## Snippet — sandboxedJsClaudeTool

```ts
import Anthropic from "@anthropic-ai/sdk";
import { sandboxedJsClaudeTool } from "@agentkit-js/claude-agent-sdk";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";

const tool = sandboxedJsClaudeTool({
  kernel: new QuickJSKernel(),
  capabilities: {
    allowedHosts: ["api.example.com"], // narrowest network policy
    cpuMs: 5_000,
    memoryLimitBytes: 64 * 1024 * 1024,
  },
});

const client = new Anthropic();
const turn = await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 512,
  tools: [
    {
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    },
  ],
  messages: [{ role: "user", content: "What is the cube of 17?" }],
});

// When turn.content has a tool_use block:
for (const block of turn.content) {
  if (block.type === "tool_use" && block.name === tool.name) {
    const result = await tool.handler(block.input);
    // …feed `result` back to the SDK as a tool_result content block.
  }
}
```

The handler returns `{ output, logs }` — the model sees what the
snippet returned, plus any `console.log` output it produced.

## Snippet — codeModeClaudeTool

```ts
import { codeModeClaudeTool } from "@agentkit-js/claude-agent-sdk";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";
import { ToolRegistry } from "@agentkit-js/core";

const reg = new ToolRegistry();
reg.register({ /* tool defs — see ToolRegistry docs */ });

const tool = codeModeClaudeTool({
  kernel: new QuickJSKernel(),
  tools: reg,
});

// Now Claude only sees one tool — `execute_code`. Its snippet may call
// callTool("name", args) against any registered tool, and only the
// final return value re-enters Claude's context.
```

Why bother: at N=30 user-defined tools, code-mode uses ≤14% of the
tokens of direct tool-use mode (see
[`examples/benchmarks/code-mode-tokens.mjs`](../../examples/benchmarks/code-mode-tokens.mjs)).
The token-saving is structural — the model picks one tool from the
catalogue, not N — and compounds with prompt cache.

## Capability manifest cheat sheet

The `capabilities` option threads through to the kernel verbatim.
The fields and their cross-kernel enforcement matrix live in
[`docs/strategy/security-face.md`](../strategy/security-face.md).

The minimal sane manifest for a third-party-LLM workload:

```ts
{
  allowedHosts: [],            // no network
  allowedReadPaths: [],        // no FS reads
  allowedWritePaths: [],       // no FS writes
  cpuMs: 5_000,                // 5s wall ceiling
  memoryLimitBytes: 64_000_000 // 64 MB
}
```

Loosen one field at a time, test, then loosen the next.

## When to use which tool

| Scenario                                                       | Tool                                |
|----------------------------------------------------------------|-------------------------------------|
| One-shot snippet (math, JSON wrangling, parsing)               | `sandboxedJsClaudeTool`             |
| The model needs to chain ≥3 of your registered tools           | `codeModeClaudeTool`                |
| You want a single tool surface even for the chain case         | `codeModeClaudeTool`                |
| Worker / edge environment (no node:vm)                         | Either, with `QuickJSKernel`        |
| Multi-tenant SaaS / untrusted code                             | Either, with `RemoteSandboxKernel`  |

The kernel selection decision tree is in
[`docs/kernels/comparison.md`](../kernels/comparison.md). The same
kernel works under all three upstream adapters
(`@agentkit-js/aisdk`, `@agentkit-js/openai-agents`,
`@agentkit-js/claude-agent-sdk`) without re-configuration.
