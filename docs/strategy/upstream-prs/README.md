# Upstream PR drafts (D1 follow-up + 2026-06-12 Direction 1)

> Last refreshed: **2026-06-12**.

This directory holds **drafts**, three of which have been filed
(one PR, two issues after the local working copy of the target file
revealed the original PR shape would have been wrong) and one new
high-priority draft awaiting a pre-submission shim.

The strategic context lives in
[`../2026-06-competitiveness.md`](../2026-06-competitiveness.md) (L1
"Become the embedded runtime"). The 2026-06-12 optimization brief's
Direction 1 explicitly raises this from "appendix" to "highest
leverage" — a single landed entry in an upstream's official docs is
worth more than an in-repo adapter.

## Submission record

| Draft                                         | Target repo                       | What was filed                                      |
|-----------------------------------------------|-----------------------------------|-----------------------------------------------------|
| [`awesome-mcp-servers-frameworks-entry.md`](awesome-mcp-servers-frameworks-entry.md) | `punkpeye/awesome-mcp-servers` | **PR** [#7910](https://github.com/punkpeye/awesome-mcp-servers/pull/7910) — added to `Code Execution` section, single-line diff |
| [`mastra-mcp-overview-link.md`](mastra-mcp-overview-link.md)                 | `mastra-ai/mastra`                | **Issue** [#17884](https://github.com/mastra-ai/mastra/issues/17884) — `docs/mcp/overview.mdx` has no clean insertion point; asked for content-shape decision before PR |
| [`vercel-ai-sdk-mcp-example.md`](vercel-ai-sdk-mcp-example.md)               | `vercel/ai`                       | **Issue** [#16063](https://github.com/vercel/ai/issues/16063) — example placement (`examples/mcp-*` vs `sandboxed-tools` vs cookbook) needs maintainer nod first |
| [`cloudflare-codemode-byo-executor.md`](cloudflare-codemode-byo-executor.md) | `cloudflare/agents`               | **DRAFT** — pre-submission gate: land `agentkitCodemodeExecutor` shim in `@agentkit-js/aisdk` first. Direction 1 priority entry. |

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

## Why the Cloudflare draft is a priority

The Cloudflare codemode docs already say
`DynamicWorkerExecutor` is "just one implementation" and that users
can build their own for "Node VM, QuickJS, containers, or any other
sandbox." `@agentkit-js/kernel-quickjs` is exactly that. The
2026-06-12 optimization brief's Direction 1 makes the case bluntly:
*one* link from the official codemode page is worth more than the
four adapter packages combined.

The pre-submission gate is real, not a stall: the recipe references
an `agentkitCodemodeExecutor` shim in `@agentkit-js/aisdk` that has
to ship first so the example actually runs. That shim is the next
landed change in this direction.

## Acceptance tracking

The acceptance criterion in each draft (merged PR / merged issue
follow-up + traceable download shift on the relevant package) holds.
When any of the four lands, update the table above and the strategy
memo's "Watch the [evals reports directory] and the upstream adapter
download graphs; that is the signal" line to point at concrete
numbers. A landed Cloudflare entry would also feed back into
[`docs/strategy/maintenance-tiers.md`](../maintenance-tiers.md) —
`kernel-quickjs` and `kernel-pyodide` are already ★ Core, so the
signal is the *adapter* download shift, not a re-tiering.

## How a contributor picks an upstream to push on

If you arrived here from
[`CONTRIBUTING.md`'s "Looking for a co-maintainer" pointer](../../../CONTRIBUTING.md#looking-for-a-co-maintainer),
the highest-leverage thing you can do is:

1. Pick the upstream community you're already embedded in.
2. Read the corresponding draft above.
3. Open an issue in the *target* repo first (per the patterns
   above) to get the maintainers' content-shape preference.
4. Follow up with the PR they ask for.

A contributor who lands one of these is the natural co-maintainer
candidate — that is exactly the shape called out in
[`GOVERNANCE.md`](../../../GOVERNANCE.md).
