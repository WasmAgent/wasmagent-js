# D5 follow-up: per-adapter StackBlitz demos (2026-06-13)

> Created 2026-06-13 in response to the optimization brief's
> Direction 5: each adapter gets a minimal mergeable upstream docs
> PR + a runnable StackBlitz example.

The four adapter packages now each have:

- a "Open in StackBlitz" button at the top of their README
  pointing at `examples/<adapter>-quickjs/` in this repo,
- a runnable demo in that directory exercising the public surface
  end-to-end (`tool.handler`/`tool.execute`/`sandbox.execute`/
  `sandboxedJsTool`),
- a smoke-tested invocation that does NOT require any cloud
  credentials (the only one that does is `aisdk-quickjs`, which
  needs `OPENAI_API_KEY` because it actually calls a model — the
  others exercise the tool directly so the demo runs offline).

| Adapter | StackBlitz demo dir | Verified |
|---|---|---|
| `@wasmagent/aisdk` | [`examples/aisdk-quickjs/`](../../../examples/aisdk-quickjs/) | requires `OPENAI_API_KEY` to run end-to-end (Vercel AI SDK round-trip) |
| `@wasmagent/mastra-sandbox` | [`examples/mastra-quickjs/`](../../../examples/mastra-quickjs/) | ✅ smoke-tested 2026-06-13 — `1+2 → 3`, `sum → 15` |
| `@wasmagent/claude-agent-sdk` | [`examples/claude-agent-quickjs/`](../../../examples/claude-agent-quickjs/) | ✅ smoke-tested 2026-06-13 — `[1,4,9]` |
| `@wasmagent/openai-agents` | [`examples/openai-agents-quickjs/`](../../../examples/openai-agents-quickjs/) | ✅ smoke-tested 2026-06-13 — `'hello-from-quickjs'` |

## Why per-adapter, not one omnibus example

Each upstream community lands on a different doc page. A
StackBlitz button on `packages/aisdk/README.md` is the right
artifact for someone landing from the Vercel AI SDK community
providers page; the same button on `packages/mastra-sandbox/README.md`
is the right artifact for someone clicking through from
`mastra.ai/docs/workspace/sandbox`. The four directories share
~30 lines each and one common kernel — the cost of keeping them
separate is much lower than the conversion cost of asking a
visitor from one community to read about another.

## Where the upstream PR fits

The four submission rows in [`README.md`](README.md) are the
upstream-side of D5. This file is the in-repo prerequisite: when
a maintainer asks "where's the runnable example?", we point at
the StackBlitz button rather than at a multi-step setup guide.

## Acceptance check

Run from the repo root:

```bash
bun install
bun run --cwd packages/aisdk build
bun run --cwd packages/mastra-sandbox build
bun run --cwd packages/claude-agent-sdk build
bun run --cwd packages/openai-agents build
bun run --cwd packages/kernel-quickjs build
node examples/mastra-quickjs/index.mjs
node examples/claude-agent-quickjs/index.mjs
node examples/openai-agents-quickjs/index.mjs
```

The first three exit `0`. The fourth (`aisdk-quickjs/index.mjs`)
needs `OPENAI_API_KEY` set; without one, it errors at the model
call but the wiring is identical to the other three.
