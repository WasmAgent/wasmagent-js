# Upstream PR drafts (D1 follow-up)

> Last refreshed: **2026-06-12**.

This directory holds **drafts**, not submitted PRs. Each file describes
the target repo, the exact branch/path the PR should touch, the body
text, and any open caveats found while researching. The drafts here
are intended to be reviewed before being filed against external
projects so we don't waste a maintainer's time with a wrong-shape
proposal.

The strategic context lives in
[`../2026-06-competitiveness.md`](../2026-06-competitiveness.md) (L1
"Become the embedded runtime"). The three drafts target the three
upstream surfaces that map to the L1 falsifiability test: if these
adapters do not get organic downloads after upstream inclusion, the
runtime pitch is wrong.

| Draft                                         | Target repo                       | Status      |
|-----------------------------------------------|-----------------------------------|-------------|
| [`vercel-ai-sdk-mcp-example.md`](vercel-ai-sdk-mcp-example.md)               | `vercel/ai`                       | DRAFT       |
| [`mastra-mcp-overview-link.md`](mastra-mcp-overview-link.md)                 | `mastra-ai/mastra`                | DRAFT       |
| [`awesome-mcp-servers-frameworks-entry.md`](awesome-mcp-servers-frameworks-entry.md) | `punkpeye/awesome-mcp-servers` | DRAFT       |

## What changed during research

The *original* plan in the optimization brief proposed targeting
Vercel AI SDK's "community providers" page and Mastra's "sandbox
provider list." Reality check (2026-06-12, verified via the GitHub
API in the drafting session):

- **Vercel AI SDK community providers** (`content/providers/03-community-providers/`)
  is explicitly scoped to *Language Model Providers* — adapter
  packages that implement the Language Model Specification V4. The
  template the maintainers point to is `13-openrouter.mdx`. agentkit
  does NOT implement that spec (it's a sandbox/kernel runtime, not a
  model adapter), so this slot is **the wrong target**. Pivoting to
  `examples/mcp` style — a runnable AI-SDK + agentkit example — is
  the legitimate analog.
- **Mastra "sandbox provider list"** referenced in the brief does
  not exist as a maintained registry. `docs/agent-builder/integrations.mdx`
  is the closest page but it covers Composio / Arcade *tool*
  providers (Enterprise Edition). The legitimate target is the
  generic MCP docs (`docs/mcp/overview.mdx` and `docs/mcp/mcp-apps.mdx`),
  which currently mention specific vendors and could absorb a one-line
  pointer to agentkit's MCP code-mode server.
- **awesome-mcp-servers** is appropriate — its `Frameworks` section
  is exactly the right home for `@agentkit-js/mcp-server`.

The rest of this directory contains the corrected drafts.
