# aisdk-quickjs — Vercel AI SDK + agentkit-js (D5 StackBlitz demo)

Smallest possible "Vercel AI SDK with a sandboxed JS tool" example. Runs on
StackBlitz with no setup beyond `OPENAI_API_KEY`.

```bash
npm install
OPENAI_API_KEY=sk-... node index.mjs
```

## What this shows

- `sandboxedJsTool({ kernel })` — one line wires a QuickJS-in-WASM sandbox
  into Vercel AI SDK as a `tool()`.
- The model can call `runJs({ code: "..." })`; the script runs in-isolate
  with a 3-second CPU cap. No `node:vm`, no E2B, no container.
- Same code runs on Cloudflare Workers, Vercel Edge, browser, or Node.

## See also

- [`@wasmagent/aisdk` README](../../packages/aisdk/README.md)
- [`docs/guides/code-mode.md`](../../docs/guides/code-mode.md)
