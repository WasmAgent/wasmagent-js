# claude-agent-quickjs — Claude Agent SDK + WasmAgent (D5 StackBlitz demo)

```bash
npm install
node index.mjs
```

What this shows: `sandboxedJsClaudeTool({ kernel })` returns the exact shape
the Claude Agent SDK expects in its `tools` array — `{ name, description,
input_schema, run }`. The kernel can be QuickJS / Pyodide / Wasmtime / Remote;
the tool surface is the same.

See [`@wasmagent/claude-agent-sdk` README](../../packages/claude-agent-sdk/README.md).
