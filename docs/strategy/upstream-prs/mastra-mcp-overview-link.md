# Draft: mastra-ai/mastra — pointer in `docs/mcp/`

**Target repo:** [`mastra-ai/mastra`](https://github.com/mastra-ai/mastra)
**Target path:** `docs/src/content/en/docs/mcp/overview.mdx` (or `mcp-apps.mdx`)
**Status:** DRAFT — not submitted.

## Why this target, not the "sandbox provider list"

The optimization brief referenced a Mastra "sandbox provider list"
that would naturally absorb WasmAgent alongside Blaxel and E2B. That
list does not exist as a maintained registry as of 2026-06-12. The
closest pages found in the actual repo:

- `docs/src/content/en/docs/agent-builder/integrations.mdx` — covers
  *tool* providers (Composio, Arcade) for Mastra Enterprise
  Edition's Agent Builder, not sandbox providers.
- `docs/src/content/en/docs/mcp/` — has only two files
  (`overview.mdx`, `mcp-apps.mdx`); the natural home for a one-line
  pointer to WasmAgent's MCP code-mode server.

We propose a small, additive PR against `docs/mcp/overview.mdx` with
a *Notable third-party MCP servers* sub-section listing one or two
options (WasmAgent + at least one other already-published server, to
avoid the appearance of a self-promotion-only PR).

## Files to touch

```
docs/src/content/en/docs/mcp/overview.mdx     ← add a sub-section
```

## Proposed sub-section content

```mdx
## Notable third-party MCP servers

The MCP ecosystem has converged on the *code-mode* shape: a server
that exposes one `execute_code` surface plus a `docs_search` surface
covering N downstream tools. Notable open-source implementations a
Mastra app might consume:

- [`@wasmagent/mcp-server`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/mcp-server)
  — `createCodeModeServer` plus a `createFetchHandler` for any
  Workers / Node / Bun host. Three-tier sandbox kernel (in-process
  / WASM / remote) is honoured uniformly via a unified
  `CapabilityManifest`. Apache-2.0.

(Add others here as they emerge. To submit one, open a PR
referencing this section.)
```

## PR title

> docs(mcp): add a Notable third-party MCP servers sub-section in `overview.mdx`

## PR body (proposed)

> The MCP overview page currently introduces the MCP protocol and
> Mastra's role; it does not point readers to existing third-party
> server implementations they might consume from a Mastra agent.
> Adding a small sub-section helps readers who are evaluating which
> MCP server to embed without leaving the docs.
>
> This PR adds a single sub-section ("Notable third-party MCP
> servers") to `overview.mdx`. The first entry is
> [`@wasmagent/mcp-server`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/mcp-server),
> which exposes the `execute_code` + `docs_search` two-tool code-mode
> surface introduced by Cloudflare's Code Mode MCP and Anthropic's
> Code Execution with MCP. It pairs with any of WasmAgent's three
> sandbox kernels (in-process node:vm, WASM via QuickJS / Pyodide /
> Wasmtime, remote microVM via E2B / CF Sandbox).
>
> Token-saving benchmark in WasmAgent's CI: the bootstrap-context cost
> drops to 13.6% of direct-tool-use at N=30 tools (`examples/benchmarks/code-mode-tokens.mjs`).
>
> The section is intentionally additive — no Mastra-side code or
> dep changes. Future PRs from other MCP server authors can extend
> the same list without re-litigating placement.

## Caveats noted during drafting

1. **Mastra has been aggressive about merge cadence post-Series-A
   (2026-04)** but has also been protective of the docs site's
   editorial voice. The PR body must read as additive ("here is
   what readers might want to find next"), not promotional.
2. **Don't add WasmAgent-specific details** beyond the package
   name and one-line description. The page is Mastra's, not ours.
3. **Watch for a request to extend the list.** If a maintainer asks
   for ≥2 entries before merging, propose Cloudflare's own Code Mode
   MCP server (already public, makes the list look genuinely
   curated) plus WasmAgent. Both are public and Apache/MIT-licensed.

## Acceptance criteria for "this PR worked"

- Merged into `mastra-ai/mastra` `main`.
- `@wasmagent/mcp-server` weekly downloads non-zero with a
  traceable shift after the docs site rebuilds.
- One inbound issue or PR from a Mastra user referencing the listing.
