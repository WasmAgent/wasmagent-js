# Draft: vercel/ai — `examples/mcp-agentkit` example

**Target repo:** [`vercel/ai`](https://github.com/vercel/ai)
**Target path:** `examples/mcp-agentkit/` (new directory)
**Status:** DRAFT — not submitted.

## Why an example, not a community-provider entry

The first instinct is to put agentkit on the [Community Providers
page](https://github.com/vercel/ai/tree/main/content/providers/03-community-providers).
That page is wrong: its [template](https://github.com/vercel/ai/blob/main/content/providers/03-community-providers/01-custom-providers.mdx)
explicitly scopes the section to **Language Model Providers**
implementing AI SDK's Language Model Specification V4. agentkit-js
is a *sandbox/kernel runtime* (`@wasmagent/aisdk` exposes
`sandboxedJsTool()` / `codeModeTool()` for `tool()`-shaped use); it
does not implement V4.

The `examples/` tree is the appropriate analog. There is already an
[`examples/mcp/`](https://github.com/vercel/ai/tree/main/examples/mcp)
directory; we are proposing a sibling that demonstrates `tool()` +
agentkit kernel + code-mode in one runnable script.

## Files to add

```
examples/mcp-agentkit/
├── .env.example
├── README.md
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
```

The shape mirrors `examples/mcp/`. The example:

- Builds a `ToolRegistry` with two trivial tools (a calculator + a
  string formatter).
- Wraps them in `codeModeTool({ kernel: new QuickJSKernel(), tools })`
  from `@wasmagent/aisdk`.
- Runs an Anthropic / OpenAI agent against a single user message,
  shows the model proposing one `execute_code` call rather than
  multiple direct tool calls.
- Logs token counts side-by-side with the direct-tool-use baseline
  so the reader sees the saving.

## PR title

> docs(examples): add `examples/mcp-agentkit` — code-mode tool with sandboxed kernel

## PR body (proposed)

> This adds a runnable example showing how to use AI SDK's `tool()`
> with [`@wasmagent/aisdk`](https://www.npmjs.com/package/@wasmagent/aisdk),
> which lets the agent's tool-execution path run inside a WASM
> sandbox (QuickJS, Wasmtime, or Pyodide) instead of running JS
> directly in the host runtime.
>
> The example mirrors the structure of `examples/mcp/`. Differences:
>
> - Tools are wrapped via `codeModeTool({ kernel, tools })`, which
>   surfaces *one* `execute_code` tool to the model instead of N
>   direct tools — at N=30 tools the bootstrap-token cost drops to
>   13.6% of direct-tool-use ([benchmark in agentkit-js
>   CI](https://github.com/WasmAgent/wasmagent-js/blob/main/examples/benchmarks/code-mode-tokens.mjs)).
> - Capability gating (`allowedHosts`, `cpuMs`, `memoryLimitBytes`)
>   is enforced cross-kernel, so the same example works on Workers
>   (QuickJS), Node (Pyodide for Python), or behind a remote sandbox.
>
> No new dependency in the AI SDK package itself — `@wasmagent/aisdk`
> only declares `ai ^4 || ^5 || ^6` as a peer-dep, so the example
> consumes whatever AI SDK version `examples/` is pinned to.
>
> Why this matters for AI SDK users: tool execution in agent loops
> is the biggest unaudited surface today; a drop-in `tool()` factory
> that runs inside WASM closes that gap without giving up the AI
> SDK's UX. Closes the gap that
> [Cloudflare's Code Mode MCP](https://blog.cloudflare.com/code-mode/)
> recently popularised, but in a runtime-neutral form.
>
> The example builds with `pnpm i && pnpm tsx src/index.ts` and runs
> in <2s. Tested locally with `@anthropic-ai/sdk@0.55` and
> `ai@v6.0.0`.

## Caveats noted during drafting

1. **AI SDK PR cadence is high but rejection rate is also high
   for "promotional" examples.** The PR body must lead with the
   AI SDK user's *technical* benefit (tool sandbox + token saving),
   not with agentkit-js's adoption story.
2. **Naming.** `examples/mcp-agentkit/` is descriptive; the
   maintainers may prefer `examples/sandboxed-tools/` which sidesteps
   the MCP framing. Both are acceptable; defer to maintainer's preference
   in review.
3. **The example must run without an Anthropic / OpenAI key.** Use a
   mock model (the AI SDK's `MockLanguageModelV2`) with a deterministic
   tool-call sequence — same pattern as `examples/mcp/src/index.ts`.
4. **License compatibility.** AI SDK is Apache-2.0; agentkit is
   Apache-2.0. No issue.

## Acceptance criteria for "this PR worked"

- Merged into `vercel/ai` `main`.
- `@wasmagent/aisdk` weekly downloads non-zero and traceable to AI
  SDK referrer (npm registry referrer header is unreliable; we'll
  read the magnitude shift instead).
- One inbound issue or PR from an AI SDK user citing the example.
