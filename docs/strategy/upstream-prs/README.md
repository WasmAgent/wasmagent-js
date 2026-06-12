# Upstream PR drafts (D1 follow-up)

> Last refreshed: **2026-06-12**.

This directory holds **drafts**, of which one was submitted as a PR
and two were submitted as issues after the local working copy of the
target file revealed the original PR shape would have been wrong.
The strategic context lives in
[`../2026-06-competitiveness.md`](../2026-06-competitiveness.md) (L1
"Become the embedded runtime").

## Submission record

| Draft                                         | Target repo                       | What was filed                                      |
|-----------------------------------------------|-----------------------------------|-----------------------------------------------------|
| [`awesome-mcp-servers-frameworks-entry.md`](awesome-mcp-servers-frameworks-entry.md) | `punkpeye/awesome-mcp-servers` | **PR** [#7910](https://github.com/punkpeye/awesome-mcp-servers/pull/7910) — added to `Code Execution` section, single-line diff |
| [`mastra-mcp-overview-link.md`](mastra-mcp-overview-link.md)                 | `mastra-ai/mastra`                | **Issue** [#17884](https://github.com/mastra-ai/mastra/issues/17884) — `docs/mcp/overview.mdx` has no clean insertion point; asked for content-shape decision before PR |
| [`vercel-ai-sdk-mcp-example.md`](vercel-ai-sdk-mcp-example.md)               | `vercel/ai`                       | **Issue** [#16063](https://github.com/vercel/ai/issues/16063) — example placement (`examples/mcp-*` vs `sandboxed-tools` vs cookbook) needs maintainer nod first |

## Why two were issues, not PRs

The drafts assumed both target pages had a clean insertion point. The
local working copies, read on submission day, did not:

- **Mastra** — `overview.mdx`'s `## Connecting to an MCP registry`
  Tabs section lists *hosted registries* (Klavis, mcp.run, Composio,
  Smithery, Apify, Ampersand). agentkit is a single open-source MCP
  server *library*, not a registry — adding it as a tab would be
  the wrong shape. The honest move is to ask the maintainers if
  they'd accept a separate "Open-source MCP server libraries"
  section, with agentkit as one of multiple seed entries.
- **vercel/ai** — `examples/mcp/` uses `experimental_createMCPClient`
  to *consume* an MCP server, which is a different shape from
  `tool()` + sandbox-kernel. Naming the new dir `mcp-agentkit/` would
  be misleading. The honest move is to ask the maintainers whether
  they'd prefer `examples/sandboxed-tools/`, a docs cookbook entry,
  or to skip it.

These are the maintainers' content-shape decisions, not ours. A
maintainer's "no thanks, this isn't a fit" is itself a useful data
point — it's exactly the falsifiability test the strategy memo lays
out.

## Acceptance tracking

The acceptance criterion in each draft (merged PR + traceable
download shift on the relevant package) holds. When any of the
three lands, update the table above and the strategy memo's
"Watch the [evals reports directory] and the upstream adapter
download graphs; that is the signal" line to point at concrete
numbers.
