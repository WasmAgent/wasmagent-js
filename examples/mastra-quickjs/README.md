# mastra-quickjs — Mastra sandbox provider via agentkit-js (D5 StackBlitz demo)

Drop-in WASM sandbox provider for Mastra `Workspace`s. Replaces Blaxel /
Daytona / E2B / Modal / Railway with an in-process QuickJS-in-WASM kernel —
no cloud account, no per-second billing, runs on the edge.

```bash
npm install
node index.mjs
```

## What this shows

- `agentkitMastraSandbox({ kernel, capabilities })` — implements Mastra's
  sandbox-provider contract directly.
- Pass it as `workspace.sandbox` in your Mastra `Agent` setup once you
  have `@mastra/core` installed; everything else stays Mastra-shaped.

## See also

- [`@wasmagent/mastra-sandbox` README](../../packages/mastra-sandbox/README.md)
