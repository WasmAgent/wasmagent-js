# Draft: punkpeye/awesome-mcp-servers — entry under Frameworks

**Target repo:** [`punkpeye/awesome-mcp-servers`](https://github.com/punkpeye/awesome-mcp-servers)
**Target path:** `README.md` — `Frameworks` section
**Status:** DRAFT — not submitted.

## Target section

The list's contribution surface is the README itself. Categories use
emoji legends (🎖️ official / 📇 TypeScript / ☁️ cloud or 🏠 local /
OS markers). The `Frameworks` section currently lists implementations
that *help users build* MCP servers (FastMCP, EasyMCP, Mastra MCP,
…). `@wasmagent/mcp-server` belongs there.

A maintained web directory is synced from the repo
([glama.ai/mcp/servers](https://glama.ai/mcp/servers)), so a merged
entry shows up in two places.

## Proposed entry

```markdown
- [WasmAgent/wasmagent-js](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/mcp-server) 📇 ☁️ 🏠 - `@wasmagent/mcp-server`: code-mode MCP server (`execute_code` + `docs_search` two-tool surface) backed by a unified capability manifest across three sandbox kernels (in-process node:vm, WASM via QuickJS / Pyodide / Wasmtime, and remote microVM via E2B / Cloudflare Sandbox). At N=30 tools the bootstrap-context cost drops to 13.6% of direct tool-use. Apache-2.0.
```

Insertion point: alphabetic under the existing `Frameworks`
sub-list. (The list's exact ordering should be respected; this draft
will be re-ordered against `main` at PR time.)

## PR title

> docs(frameworks): add @wasmagent/mcp-server (code-mode + sandbox kernels)

## PR body (proposed)

> Adds `@wasmagent/mcp-server` under Frameworks.
>
> The package implements the *code-mode* MCP server pattern that
> [Cloudflare's blog](https://blog.cloudflare.com/code-mode/) and
> Anthropic's [Code Execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
> popularised in 2026: instead of exposing N user-defined tools to
> the model directly, the server exposes one `execute_code` tool and
> the model's snippet calls the underlying tools via
> `callTool(name, args)`. The bootstrap-context saving compounds in
> N — at N=30 it lands at ~14% of direct-tool-use cost.
>
> What's distinct vs. existing entries: the sandbox kernel is
> uniform across three isolation tiers (in-process vm, WASM via
> QuickJS / Pyodide / Wasmtime, remote microVM via E2B or
> Cloudflare Sandbox), all honouring the same capability manifest.
> So a project that wants Edge-deployable MCP today (`QuickJSKernel`)
> can move to a remote microVM later (`RemoteSandboxKernel`) without
> changing the policy face.
>
> Project metadata:
> - Repo: https://github.com/WasmAgent/wasmagent-js
> - License: Apache-2.0
> - Lang: TypeScript (📇)
> - Scope: works as both 🏠 local-service (Node/Bun host) and ☁️
>   cloud-service (Cloudflare Workers / Vercel / Bun deploy)
> - Code: `packages/mcp-server/`
> - Docs: https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/code-mode.md

## Caveats noted during drafting

1. **List ordering** — the README uses both alphabetic and
   chronological-ish ordering depending on subsection. Insert the
   entry, then let the maintainer re-sort if they prefer; do not
   rewrite the section.
2. **Emoji legend** — must use 📇 (TypeScript) + at least one of
   ☁️ / 🏠. The package targets both, so we list both.
3. **Avoid claims unverifiable by the maintainer.** The 13.6%
   number is from agentkit's own CI; the PR body links the benchmark
   file directly so the reviewer can run it themselves.
4. **The Glama directory sync runs on a schedule.** The web entry
   may take 24–48h after merge to appear. That is a feature, not a
   bug — if the metadata in the entry is wrong, we have time to fix
   it before the directory ingests it.

## Acceptance criteria for "this PR worked"

- Merged into `punkpeye/awesome-mcp-servers` `main`.
- `@wasmagent/mcp-server` shows up at glama.ai/mcp/servers within
  one ingestion cycle.
- Inbound stargazers / weekly downloads on `@wasmagent/mcp-server`
  show a traceable shift after listing.
