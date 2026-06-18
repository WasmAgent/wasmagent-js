# kernel-only example

This example demonstrates that the agentkit-js code-execution kernels are
**standalone WASM sandboxes** — they don't require `@wasmagent/core` or any
framework-level integration. You can drop them into any agent framework that
takes a tool definition.

```bash
node examples/kernel-only/index.mjs
```

What you'll see: synchronous JS in a QuickJS WASM sandbox, captured stdout,
the security boundary that prevents reaching host globals, and a clean
shutdown — without any agentkit-js framework code on the import graph.

## Use it from your own framework

The kernel API is small and stable:

```ts
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const kernel = new QuickJSKernel();
const { value, stdout, error } = await kernel.execute({
  code: "...",
  timeoutMs: 5_000,
});
```

For end-to-end recipes:

- [Use kernels with Vercel AI SDK](../../docs/guides/integrate-vercel-ai-sdk.md)
- [Use kernels with Mastra](../../docs/guides/integrate-mastra.md)
