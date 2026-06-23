# Draft: langchain-ai/langchainjs — sandboxed tool example

**Target repo:** [`langchain-ai/langchainjs`](https://github.com/langchain-ai/langchainjs)
**Target path:** `examples/src/tools/sandboxed_execution.ts`
**Status:** 🟡 OPEN — issue filed 2026-06-23

## Why LangChain.js

LangChain.js has `DynamicStructuredTool` and a rich tool ecosystem, but no
sandboxed execution layer. The examples directory is the right contribution
surface — separate integration packages are no longer accepted in their monorepo.

## What we learned from the codebase

LangChain.js tools have:
- **`responseFormat: "content_and_artifact"`** — returns both a model-context
  string and a structured artifact for the caller. Equivalent to our
  `toModelOutput` + `ToolResult.output` separation. Good naming to adopt.
- **`returnDirect`** — stops agent loop after one tool call. Simpler than
  wiring a StopCondition for single-step tools.
- `DynamicStructuredTool` takes `{ name, description, schema, func }` — clean,
  composable, no class inheritance needed.

## Contribution shape

A new file `examples/src/tools/sandboxed_execution.ts`:

```ts
import { DynamicStructuredTool } from '@langchain/core/tools';
import { AgentExecutor, createToolCallingAgent } from 'langchain/agents';
import { sandboxedJsTool } from '@wasmagent/aisdk';
import { QuickJSKernel } from '@wasmagent/kernel-quickjs';
import { MockChatModel } from '@langchain/core/utils/testing'; // CI-safe, no key needed
import { z } from 'zod';

// Wrap the WasmAgent kernel as a LangChain DynamicStructuredTool
const sandboxTool = new DynamicStructuredTool({
  name: 'execute_code',
  description: 'Run a JS snippet in a WASM sandbox. Returns { output, logs }.',
  schema: z.object({ code: z.string() }),
  func: async ({ code }) => {
    const kernel = new QuickJSKernel({ timeoutMs: 5000 });
    const result = await kernel.run(code, { cpuMs: 3000 });
    return JSON.stringify({ output: result.output, logs: result.logs });
  },
});
```

## Acceptance criteria

- PR merged to `langchain-ai/langchainjs` `examples/src/tools/`.
- Example runs without API key (uses MockChatModel or similar).
- Referenced from LangChain.js docs or cookbook.
