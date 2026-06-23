# Upstream PR drafts

> Last refreshed: **2026-06-23**.

This directory holds drafts and filed records for upstream contributions.

The strategic context lives in
[`../2026-06-competitiveness.md`](../2026-06-competitiveness.md) (L1
"Become the embedded runtime"). A single landed entry in an upstream's official
docs is worth more than an in-repo adapter.

## Submission record

| Draft | Target repo | Status |
|-------|-------------|--------|
| [`awesome-mcp-servers-frameworks-entry.md`](awesome-mcp-servers-frameworks-entry.md) | `punkpeye/awesome-mcp-servers` | ✅ **MERGED** PR [#7910](https://github.com/punkpeye/awesome-mcp-servers/pull/7910) |
| [`vercel-ai-sdk-mcp-example.md`](vercel-ai-sdk-mcp-example.md) | `vercel/ai` | 🟡 **OPEN** PR [#16318](https://github.com/vercel/ai/pull/16318) — filed 2026-06-23, bot review passed, awaiting maintainer |
| [`cloudflare-codemode-byo-executor.md`](cloudflare-codemode-byo-executor.md) | `cloudflare/agents` | 🔴 **CLOSED** issue [#1771](https://github.com/cloudflare/agents/issues/1771) — no maintainer action; re-pitch after vercel/ai lands |
| [`mastra-mcp-overview-link.md`](mastra-mcp-overview-link.md) | `mastra-ai/mastra` | 🔴 **CLOSED** issue [#17884](https://github.com/mastra-ai/mastra/issues/17884) — "no third-party additions at the moment"; re-pitch after benchmark lands |
| [`elizaos-sandboxed-action.md`](elizaos-sandboxed-action.md) | `elizaOS/eliza` | 🟡 **OPEN** issue filed 2026-06-23 |
| [`langchainjs-sandboxed-tool-example.md`](langchainjs-sandboxed-tool-example.md) | `langchain-ai/langchainjs` | 🟡 **OPEN** issue filed 2026-06-23 |

## What we learned from researching target repos (2026-06-23)

### elizaOS — patterns worth adopting

- **`descriptionCompressed`** on Action: a brevity-optimized description used
  in token-constrained contexts (e.g. deferred tool search). Adopted into
  `ToolDefinition.descriptionCompressed` + `ToolRegistry.toJsonSchema({ compact })`.
- **`ActionResult.userFacingText` + `verifiedUserFacing`**: separates diagnostic
  text from the user-facing reply; "verified" marks canonical replies the model
  must not paraphrase. Good pattern for `ToolResult` if we ever add a UI layer.
- **`cleanup?: () => void`** on ActionResult: deterministic resource cleanup
  without requiring try/finally in every handler. Similar to our `[Symbol.asyncDispose]`
  on kernels but at the tool-result level.
- **`suppressEarlyReply`** on Action: suppresses a draft reply for async actions
  (e.g. sub-agent spawn). Maps to our multi-step agent flow.

### LangChain.js — patterns worth adopting

- **`responseFormat: "content_and_artifact"`** on Tool: lets a tool return both
  a string (for the model context) and a structured artifact (for the caller).
  This is exactly what `toModelOutput` + `ToolResult.output` achieve in our
  codebase, but LangChain names it more explicitly.
- **`returnDirect`** on Tool: stops the agent loop immediately after one tool
  call. Maps to our `StopCondition` but at the per-tool level — simpler for
  simple use cases.

### AutoGen — not applicable

AutoGen is Python-only (TypeScript is only the Studio UI). Our kernels
already support Python via PyodideKernel; a Python binding is the right
integration shape, not a JS executor. Skip.

## How a contributor picks an upstream to push on

1. Pick the upstream community you're already embedded in.
2. Read the corresponding draft below.
3. Open an issue in the target repo first to get the maintainers'
   content-shape preference.
4. Follow up with the PR they ask for.

## Submission record

| Draft                                         | Target repo                       | What was filed                                                                                                                                                                                                                                                |
|-----------------------------------------------|-----------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| [`awesome-mcp-servers-frameworks-entry.md`](awesome-mcp-servers-frameworks-entry.md) | `punkpeye/awesome-mcp-servers` | **PR** [#7910](https://github.com/punkpeye/awesome-mcp-servers/pull/7910) — 🟡 OPEN. Glama bot ([2026-06-12](https://github.com/punkpeye/awesome-mcp-servers/pull/7910#issuecomment-4689364380)) requires (1) listing on `glama.ai/mcp/servers` with health checks and (2) Glama score badge in the entry. Action: Glama listing + PR amendment. |
| [`mastra-mcp-overview-link.md`](mastra-mcp-overview-link.md)                 | `mastra-ai/mastra`                | **Issue** [#17884](https://github.com/mastra-ai/mastra/issues/17884) — 🔴 **CLOSED** by maintainer @roaminro ([2026-06-12](https://github.com/mastra-ai/mastra/issues/17884#issuecomment-4691748965)): *"we're not adding any new third-party projects to that section at the moment."* See "Maintainer responses" below for what this means strategically.                |
| [`vercel-ai-sdk-mcp-example.md`](vercel-ai-sdk-mcp-example.md)               | `vercel/ai`                       | **Issue** [#16063](https://github.com/vercel/ai/issues/16063) — 🟡 OPEN, no maintainer response as of 2026-06-12. Standing by per the issue body's request for content-shape preference.                                                                       |
| [`cloudflare-codemode-byo-executor.md`](cloudflare-codemode-byo-executor.md) | `cloudflare/agents`               | **Issue** [#1753](https://github.com/cloudflare/agents/issues/1753) — filed 2026-06-13. cloudflare/agents has `pull_request_creation_policy: collaborators_only`, so the change ships as an issue with a link to a ready-to-cherry-pick branch on the fork at [`telleroutlook/agents@docs/codemode-byo-executor`](https://github.com/telleroutlook/agents/tree/docs/codemode-byo-executor) (+34/-2 in `docs/codemode.md`). agentkit-js Direction 1 priority entry. |

## Maintainer responses (2026-06-12)

The strategy memo's
[falsifiability test](../2026-06-competitiveness.md#5-how-to-challenge-this-memo)
is in part exactly *this* — does the upstream-runtime story land
with upstream maintainers? Three responses arrived inside the
first day; here is what each one tells us.

### `awesome-mcp-servers#7910` — conditional acceptance

The Glama bot requirement is mechanical (Glama listing + badge),
not a maintainer rejection. Path forward:

1. List `@wasmagent/mcp-server` at `glama.ai/mcp/servers`. The
   server already starts and answers introspection (CI verifies
   it); no code change needed for the listing itself.
2. Wait for Glama's health-check pass (typical ~24h ingestion).
3. Amend the PR body with the Glama score badge:

   ```markdown
   [![WasmAgent/wasmagent-js MCP server](https://glama.ai/mcp/servers/WasmAgent/wasmagent-js/badges/score.svg)](https://glama.ai/mcp/servers/WasmAgent/wasmagent-js)
   ```

This is the unambiguous follow-up: do the mechanical work, the
PR moves. Tracked as the next concrete action under Direction 1.

### `mastra-ai/mastra#17884` — explicit decline

`@roaminro` (Mastra MEMBER) closed the issue with: *"we're not
adding any new third-party projects to that section at the
moment."* This is **not** a content-shape disagreement (the
draft anticipated several content-shape options); it is a
blanket policy on the docs surface for the moment.

What this means:

- **Strategic data point, not a defeat.** Mastra is a clear case
  of "no upstream slot via official docs *right now*." The L1
  thesis ("be embedded by leaders") still holds via the **other**
  surfaces: `@wasmagent/mastra-sandbox` is already a working
  sandbox-provider package; whether or not the Mastra docs link
  to it, Mastra users can opt in directly.
- **Falsifiability tally.** One blanket decline counts as one
  data point against the easy version of L1 ("upstream docs will
  list us"). The harder version ("downloads materialize through
  any path, doc-listed or not") has not been falsified — that is
  what
  [`docs/strategy/leaderboard-plan.md`](../leaderboard-plan.md)
  and the upstream adapter download tracking are for.
- **Re-attempt window.** The phrase *"at the moment"* is a soft
  policy, not a permanent NACK. A re-pitch makes sense **after**
  agentkit lands a public benchmark number (Direction 2) or a
  large enough Mastra-side adoption signal that the policy
  resets. Until then, do not re-open #17884; that is poor
  manners and the maintainer's preference is already on record.

The draft `mastra-mcp-overview-link.md` is left in this directory
as the historical record of the ask. A follow-up draft
(`mastra-re-pitch-after-benchmark.md`) will be added once a
trigger condition is met; it is *not* prepared now because doing
so would invite premature re-opening of a closed thread.

### `vercel/ai#16063` — open, awaiting response

No maintainer response as of 2026-06-12. The issue requests a
content-shape decision (`examples/mcp/` vs `examples/sandboxed-tools/`
vs cookbook entry) before opening a PR; behaviour is to **wait**
rather than ping. If 30 days pass with no response we ping once,
politely, with a one-line nudge — that is the standard etiquette
for issue-thread maintenance and keeps the strategy memo's
"behave like a guest in their repo" line honest.

## Why two were issues, not PRs (original notes — kept for context)

The drafts assumed both target pages had a clean insertion point. The
local working copies, read on submission day, did not:

- **Mastra** — `overview.mdx`'s `## Connecting to an MCP registry`
  Tabs section lists *hosted registries* (Klavis, mcp.run, Composio,
  Smithery, Apify, Ampersand). agentkit is a single open-source MCP
  server *library*, not a registry — adding it as a tab would be
  the wrong shape. The honest move is to ask the maintainers if
  they'd accept a separate "Open-source MCP server libraries"
  section, with agentkit as one of multiple seed entries. *(Resolved
  2026-06-12: maintainer declined the section. See "Maintainer
  responses" above.)*
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
sandbox." `@wasmagent/kernel-quickjs` is exactly that. The
2026-06-12 optimization brief's Direction 1 makes the case bluntly:
*one* link from the official codemode page is worth more than the
four adapter packages combined.

The pre-submission gate is real, not a stall: the recipe references
an `agentkitCodemodeExecutor` shim in `@wasmagent/aisdk` that has
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
