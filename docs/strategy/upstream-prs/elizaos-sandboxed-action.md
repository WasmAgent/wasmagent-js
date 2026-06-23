# Draft: elizaOS/eliza — sandboxed code execution plugin

**Target repo:** [`elizaOS/eliza`](https://github.com/elizaOS/eliza)
**Target path:** community plugin via npm registry (`elizaos` keyword)
**Status:** 🟡 OPEN — issue filed 2026-06-23

## Why elizaOS

elizaOS has a rich Action/Provider/Evaluator plugin system but no sandboxed
code-execution action. The architecture has a first-class `remote` plugin mode
(Bun Worker isolation with `RemotePluginPermissions`) that is a natural fit for
a WASM kernel. The community plugin path (npm + registry listing) means no
maintainer approval gate for the initial ship.

## What we learned from the codebase

elizaOS actions have:
- `descriptionCompressed?: string` — brevity variant for token-constrained contexts.
  **Adopted into `ToolDefinition` as `descriptionCompressed`** (2026-06-23).
- `ActionResult.cleanup?: () => void` — deterministic resource teardown.
- `parameters?: ActionParameter[]` — structured input validated before handler runs.
- `suppressEarlyReply` — suppresses draft reply for async actions.

## Contribution shape

1. **Community plugin on npm** — `@wasmagent/eliza-plugin` published with `elizaos` keyword.
2. **Registry listing** — PR to `packages/registry/entries/third-party` once the
   plugin is stable.
3. **No maintainer gate** — community plugins are discovered via keyword; the PR
   to the registry is a cosmetic listing step, not a code-acceptance gate.

## Plugin interface

```ts
import type { Plugin, Action, ActionResult } from '@elizaos/core';
import { codeModeTool } from '@wasmagent/aisdk';
import { QuickJSKernel } from '@wasmagent/kernel-quickjs';

const executeSandboxedAction: Action = {
  name: 'EXECUTE_SANDBOXED_CODE',
  description: 'Execute a JavaScript snippet inside a WASM sandbox ...',
  descriptionCompressed: 'Run JS in WASM sandbox via callTool()',
  parameters: [{ name: 'code', type: 'string', required: true }],
  validate: async (_runtime, message) => message.content.text?.includes('```') ?? false,
  handler: async (_runtime, _message, _state, options, callback): Promise<ActionResult> => {
    const kernel = new QuickJSKernel({ timeoutMs: 5000 });
    // ... run code, call callback with result
    return { success: true, userFacingText: result, cleanup: () => kernel[Symbol.asyncDispose]() };
  },
};

export const sandboxedCodePlugin: Plugin = {
  name: '@wasmagent/eliza-plugin',
  description: 'Sandboxed JS/Python code execution via agentkit WASM kernels',
  actions: [executeSandboxedAction],
};
```

## Acceptance criteria

- npm package `@wasmagent/eliza-plugin` published with `elizaos` keyword.
- Listed on [plugins.elizacloud.ai](https://plugins.elizacloud.ai).
- Registry PR merged to `elizaOS/eliza`.
