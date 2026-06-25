# Upstream PR Tracking

> Detailed drafts and per-submission notes live in
> [`docs/strategy/upstream-prs/README.md`](../strategy/upstream-prs/README.md).
>
> Last updated: 2026-06-25

Status of WasmAgent integration submissions to external ecosystems.

| Ecosystem | Filed as | PR / Issue | Status | Notes |
|---|---|---|---|---|
| `punkpeye/awesome-mcp-servers` | PR | [#7910](https://github.com/punkpeye/awesome-mcp-servers/pull/7910) | ✅ **MERGED** | |
| `vercel/ai` | PR | [#16318](https://github.com/vercel/ai/pull/16318) | 🟡 **OPEN** | Filed 2026-06-23; bot review passed; awaiting maintainer |
| `langchain-ai/langchainjs` | PR | [#11104](https://github.com/langchain-ai/langchainjs/pull/11104) | 🟡 **OPEN** | Filed 2026-06-24 |
| `openai/openai-agents-js` | Issue | [#1424](https://github.com/openai/openai-agents-js/issues/1424) | 🟡 **OPEN** | WASM sandbox backend; filed 2026-06-24 |
| `ag-ui-protocol/ag-ui` | Issue | [#2042](https://github.com/ag-ui-protocol/ag-ui/issues/2042) | 🟡 **OPEN** | Filed 2026-06-25; awaiting maintainer assignment before PR |
| `modelcontextprotocol/registry` | CLI publish (`mcp-publisher`) | — | ✅ **PUBLISHED** | `io.github.telleroutlook/mcp-server@1.1.1` published 2026-06-25 |
| `elizaOS/eliza` | PR | [#9244](https://github.com/elizaOS/eliza/pull/9244) | 🟡 **OPEN** | Registry PR; #9235 pivoted to capability governance (CapabilityManifest landed in `@elizaos/core`); awaiting review |
| `cloudflare/agents` | Issue | [#1771](https://github.com/cloudflare/agents/issues/1771) | 🔴 **CLOSED** | No maintainer action. **Do not re-open.** Re-pitch after vercel/ai #16318 merges |
| `mastra-ai/mastra` | Issue | [#17884](https://github.com/mastra-ai/mastra/issues/17884) | 🔴 **CLOSED** | Explicitly declined: "no third-party additions at the moment." **Do not re-open.** Re-pitch after public benchmark lands |

## Do-not-resubmit list

These were rejected or closed by maintainers. Do not file new issues/PRs
to the same surface until the re-pitch condition in the Notes column is met.

| Target | Closed thread | Re-pitch condition |
|---|---|---|
| `cloudflare/agents` codemode docs | [#1771](https://github.com/cloudflare/agents/issues/1771) | vercel/ai PR [#16318](https://github.com/vercel/ai/pull/16318) merges first |
| `mastra-ai/mastra` docs integrations | [#17884](https://github.com/mastra-ai/mastra/issues/17884) | Public benchmark report published and indexed |

## How to submit

1. Create the example/recipe in `examples/recipes/<framework>/`
2. Add to this table with status `Draft` before filing
3. Write the upstream PR/issue targeting their examples/docs
4. Update status and link once filed
5. Update to `Merged` / `Closed` when resolved

