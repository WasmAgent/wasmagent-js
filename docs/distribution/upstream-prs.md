# Upstream PR Tracking

> Detailed drafts and per-submission notes live in
> [`docs/strategy/upstream-prs/README.md`](../strategy/upstream-prs/README.md).
>
> Last updated: **2026-08-27** (statuses re-verified against the live
> upstream threads on that date; see the Verified column)

Status of WasmAgent integration submissions to external ecosystems.
Validated by `scripts/check-upstream-pr-status.mjs`: every draft file in
`docs/strategy/upstream-prs/` must appear in the Draft doc column below
(except internal docs listed in the allowlist comment).

<!-- internal-docs: README.md, action-queue-2026-06-12.md, d5-stackblitz-demos-2026-06-13.md -->

| Ecosystem | Draft doc | Filed as | PR / Issue | Status | Verified | Notes |
|---|---|---|---|---|---|---|
| `punkpeye/awesome-mcp-servers` | `awesome-mcp-servers-frameworks-entry.md` | PR | [#7910](https://github.com/punkpeye/awesome-mcp-servers/pull/7910) | ✅ **MERGED** | 2026-06-18 | Frameworks-list entry landed. |
| `vercel/ai` | `vercel-ai-sdk-mcp-example.md` | PR | [#16318](https://github.com/vercel/ai/pull/16318) | ❌ **CLOSED** (unmerged) | 2026-06-29 | Bot review passed; closed without a maintainer merge. Re-pitch once the public benchmark lands (see do-not-resubmit conditions). |
| `langchain-ai/langchainjs` | `langchainjs-sandboxed-tool-example.md` | PR | [#11104](https://github.com/langchain-ai/langchainjs/pull/11104) | 🟡 **OPEN** | 2026-08-27 | Filed 2026-06-24; no maintainer review yet. |
| `openai/openai-agents-js` | — (issue thread only) | Issue | [#1424](https://github.com/openai/openai-agents-js/issues/1424) | ❌ **CLOSED** | 2026-06-24 | WASM sandbox backend proposal; closed within a day of filing. |
| `ag-ui-protocol/ag-ui` | `agui-integration.md` | Issue | [#2042](https://github.com/ag-ui-protocol/ag-ui/issues/2042) | 🟡 **OPEN** | 2026-08-27 | Filed 2026-06-25; awaiting maintainer assignment before PR. |
| `modelcontextprotocol/registry` | `mcp-registry-publish.md` | CLI publish (`mcp-publisher`) | — | ✅ **PUBLISHED** | 2026-06-25 | `io.github.telleroutlook/mcp-server@1.1.1` published 2026-06-25. |
| `elizaOS/eliza` | `elizaos-sandboxed-action.md` | PR | [#9244](https://github.com/elizaOS/eliza/pull/9244) | ✅ **MERGED** | 2026-06-24 | Registry PR merged; #9235 pivoted to capability governance (CapabilityManifest landed in `@elizaos/core`). |
| `cloudflare/agents` | `cloudflare-codemode-byo-executor.md` | Issue | [#1771](https://github.com/cloudflare/agents/issues/1771) | 🔴 **CLOSED** | 2026-08-27 | No maintainer action. **Do not re-open.** Re-pitch after a public benchmark lands. |
| `mastra-ai/mastra` | `mastra-mcp-overview-link.md` | Issue | [#17884](https://github.com/mastra-ai/mastra/issues/17884) | 🔴 **CLOSED** | 2026-08-27 | Explicitly declined: "no third-party additions at the moment." **Do not re-open.** Re-pitch after public benchmark lands |

## Scoreboard (verified 2026-08-27)

**2 merged / published · 2 open · 4 closed** across 8 ecosystems. The
two landed entries (awesome-mcp-servers listing, elizaOS registry) are
the pattern to repeat: small, doc-shaped contributions with an
embedded-runtime angle.

## Do-not-resubmit list

These were rejected or closed by maintainers. Do not file new issues/PRs
to the same surface until the re-pitch condition in the Notes column is met.

| Target | Closed thread | Re-pitch condition |
|---|---|---|
| `cloudflare/agents` codemode docs | [#1771](https://github.com/cloudflare/agents/issues/1771) | Public benchmark report published and indexed |
| `mastra-ai/mastra` docs integrations | [#17884](https://github.com/mastra-ai/mastra/issues/17884) | Public benchmark report published and indexed |
| `vercel/ai` MCP example PR | [#16318](https://github.com/vercel/ai/pull/16318) (closed unmerged 2026-06-29) | Land the example via a maintainer-sponsored route or after the benchmark report gives it independent notability |
| `openai/openai-agents-js` sandbox backend | [#1424](https://github.com/openai/openai-agents-js/issues/1424) | Re-file only alongside a shipped, documented integration example |

## How to submit

1. Create the example/recipe in `examples/recipes/<framework>/`
2. Add to this table with status `Draft` before filing
3. Write the upstream PR/issue targeting their examples/docs
4. Update status and link once filed
5. Update to `Merged` / `Closed` when resolved

## Validation

`node scripts/check-upstream-pr-status.mjs` (wired into `npm run check:all`)
fails when a file in `docs/strategy/upstream-prs/` has no row above.
Internal docs are exempted via the `internal-docs` allowlist comment.
