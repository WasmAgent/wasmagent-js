# WasmAgent Adapter Recipes

Self-contained examples showing how to embed the WasmAgent runtime into
popular agent frameworks. Each example is 20-30 lines and focuses on the
integration pattern; see the linked recipe doc for the full explanation.

| Recipe | Framework | Doc |
|---|---|---|
| [vercel-ai-sdk](./vercel-ai-sdk/index.mjs) | Vercel AI SDK (`sandboxedJsTool`) | [docs/recipes/vercel-ai-sdk.md](../../docs/recipes/vercel-ai-sdk.md) |
| [mastra-sandbox](./mastra-sandbox/index.mjs) | Mastra (`createMastraSandbox`) | [docs/recipes/mastra-sandbox.md](../../docs/recipes/mastra-sandbox.md) |
| [openai-agents](./openai-agents/index.mjs) | OpenAI Agents JS SDK (`sandboxedJsAgentTool`) | [docs/recipes/openai-agents.md](../../docs/recipes/openai-agents.md) |
| [claude-agent-sdk](./claude-agent-sdk/index.mjs) | Claude Agent SDK (`sandboxedJsClaudeTool`) | [docs/recipes/claude-agent-sdk.md](../../docs/recipes/claude-agent-sdk.md) |
| [mcp-code-mode](./mcp-code-mode/index.mjs) | MCP portal — N tools collapsed to 2 (`createPortalServer`) | [docs/recipes/mcp-code-mode.md](../../docs/recipes/mcp-code-mode.md) |

## Quick start

Each recipe directory is a standalone ES module. Install its dependencies as
listed at the top of `index.mjs`, then run:

```bash
node examples/recipes/<name>/index.mjs
```

The `mastra-sandbox`, `openai-agents`, `claude-agent-sdk`, and `mcp-code-mode`
recipes run without an API key. The `vercel-ai-sdk` recipe requires
`OPENAI_API_KEY`.

## Kernel tiers

All recipes use `QuickJSKernel` (edge-safe WASM isolation). Swap the
constructor to upgrade isolation tier without touching the rest of the code:

| Kernel | Isolation | When to use |
|---|---|---|
| `JsKernel` | none (host process) | local dev, trusted code only |
| `QuickJSKernel` | QuickJS VM | edge / Workers, untrusted snippets |
| `PyodideKernel` | QuickJS VM (Python) | Python execution on edge |
| `RemoteSandboxKernel` | microVM (E2B / CF Sandbox) | multi-tenant, strong isolation |

See [docs/kernels/comparison.md](../../docs/kernels/comparison.md) for the
full decision tree.
