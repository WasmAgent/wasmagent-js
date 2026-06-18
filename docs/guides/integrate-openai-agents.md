# Use agentkit kernels with the OpenAI Agents JS SDK

> Last refreshed: **2026-06-12**.
> Companion to [`integrate-vercel-ai-sdk.md`](integrate-vercel-ai-sdk.md)
> and [`integrate-claude-agent-sdk.md`](integrate-claude-agent-sdk.md).

The OpenAI Agents JS SDK (`@openai/agents`) runs an agent loop with
typed tools registered via `agent({ tools: […] })`. The default tool
execution path runs your `execute()` function directly. When the LLM
is generating the code that runs, that's not isolation — it is the
opposite of isolation.

`@wasmagent/openai-agents` produces tools whose `execute` is an
agentkit kernel run:

- **`sandboxedJsAgentTool`** — one-shot JS evaluator.
- **`codeModeAgentTool`** — code-mode tool (one tool surface, N
  callable downstream tools).

Both honour the unified `CapabilityManifest`. Capability decisions
you made for the MCP server or other adapters carry over verbatim —
see [`docs/strategy/security-face.md`](../strategy/security-face.md).

## Install

```bash
npm add @wasmagent/openai-agents @wasmagent/core @wasmagent/kernel-quickjs @openai/agents
```

The `@openai/agents` peer dep is declared *optional* so unit tests
don't drag it in. At runtime your app needs it to wire the tool into
an `Agent`.

## Snippet — sandboxedJsAgentTool

```ts
import { Agent } from "@openai/agents";
import { sandboxedJsAgentTool } from "@wasmagent/openai-agents";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const sandboxed = sandboxedJsAgentTool({
  kernel: new QuickJSKernel(),
  capabilities: {
    allowedHosts: [],
    cpuMs: 5_000,
    memoryLimitBytes: 64 * 1024 * 1024,
  },
});

const agent = new Agent({
  name: "math-helper",
  instructions: "You are a careful arithmetic assistant.",
  tools: [sandboxed],
});

const turn = await agent.run("What is the cube of 17?");
console.log(turn.finalOutput);
```

The agent picks `sandboxed_js`, supplies a snippet, the kernel runs
it, the result `{ output, logs }` becomes the tool result the model
sees on the next turn.

## Snippet — codeModeAgentTool

```ts
import { Agent } from "@openai/agents";
import { codeModeAgentTool } from "@wasmagent/openai-agents";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { ToolRegistry } from "@wasmagent/core";

const reg = new ToolRegistry();
reg.register({ /* tool defs — see ToolRegistry docs */ });

const codeMode = codeModeAgentTool({
  kernel: new QuickJSKernel(),
  tools: reg,
});

const agent = new Agent({
  name: "workflow-runner",
  instructions: "Use execute_code to chain registered tools when needed.",
  tools: [codeMode],
});
```

The agent now sees one tool — `execute_code`. Its snippet may call
`callTool(name, args)` against any tool in `reg`, and only the
script's final return value re-enters the model's context.

## Capability manifest cheat sheet

```ts
{
  allowedHosts: [],            // no network
  allowedReadPaths: [],        // no FS reads
  allowedWritePaths: [],       // no FS writes
  cpuMs: 5_000,
  memoryLimitBytes: 64_000_000,
}
```

The fields' cross-kernel enforcement matrix is in
[`docs/strategy/security-face.md`](../strategy/security-face.md).

## When to use which tool

| Scenario                                                       | Tool                              |
|----------------------------------------------------------------|-----------------------------------|
| One-shot snippet (math, JSON wrangling, parsing)               | `sandboxedJsAgentTool`            |
| The model needs to chain ≥3 of your registered tools           | `codeModeAgentTool`               |
| You want a single tool surface even for the chain case         | `codeModeAgentTool`               |
| Worker / edge environment                                      | Either, with `QuickJSKernel`      |
| Multi-tenant SaaS / untrusted code                             | Either, with `RemoteSandboxKernel`|

Kernel decision tree: [`docs/kernels/comparison.md`](../kernels/comparison.md).
