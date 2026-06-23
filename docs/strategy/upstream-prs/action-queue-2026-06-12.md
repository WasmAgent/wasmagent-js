# Action queue — upstream maintainer responses (2026-06-12)

> Created 2026-06-12 in response to maintainer activity on the
> three submitted upstream entries
> ([`README.md`](README.md) — "Maintainer responses").
>
> This file is the work queue. Each item lists what the
> maintainer asked for, what step is mechanical (we can do it),
> and what step needs human action (a browser, an account, a
> wait).

## 1. `awesome-mcp-servers#7910` — Glama listing + badge

Status: 🟡 OPEN, awaiting Glama prerequisites.

### What the bot asked for

From the [bot
comment](https://github.com/punkpeye/awesome-mcp-servers/pull/7910#issuecomment-4689364380):

1. List `@wasmagent/mcp-server` at `glama.ai/mcp/servers`.
   Glama runs a health check (server must start and answer
   introspection); a Dockerfile must be added "directly to
   Glama" (their listing UI takes the Dockerfile).
2. Amend the PR entry to include the Glama score badge:

   ```markdown
   [![WasmAgent/wasmagent-js MCP server](https://glama.ai/mcp/servers/WasmAgent/wasmagent-js/badges/score.svg)](https://glama.ai/mcp/servers/WasmAgent/wasmagent-js)
   ```

### Step 1 (manual — needs the maintainer in a browser)

`glama.ai/mcp/servers` requires an account + the Glama submission
form. The submission form takes:

- Repo URL: `https://github.com/WasmAgent/wasmagent-js`
- Server entry path: `packages/mcp-server`
- Dockerfile: see the proposed `packages/mcp-server/Dockerfile.glama` below.

This step is documented here so the next session (or the
co-maintainer when one is named) does not have to re-derive it.

### Pre-requisite — stdio entry point

⚠️ **Verified 2026-06-12 against the package source.** Today
`@wasmagent/mcp-server` is a **transport-agnostic** library: its
`index.ts` exports `McpAgentServer` (with a `.handle()` method) and
`fetchHandler.ts` adds an HTTP transport, but there is **no
out-of-the-box stdio CLI** entry point. Glama's health check
expects a Docker image whose `CMD` answers MCP introspection on
stdio.

So the Glama listing PR has to land in two parts:

1. A small new file `packages/mcp-server/src/stdio.ts` that wires
   `createCodeModeServer({ kernel, capabilities })` to a stdio
   transport via `@modelcontextprotocol/sdk`'s
   `StdioServerTransport`. This is ~30 lines and does not change
   the existing public API — it is a new bin entry, not a
   replacement.
2. `package.json` adds:

   ```json
   "bin": {
     "WasmAgent-mcp-server": "./dist/stdio.js"
   }
   ```

   so both `npx @wasmagent/mcp-server` (for Glama health-check
   and for users who want stdio MCP) and the existing `import`
   path (for users who want the library) work.

This is genuine product work — small, but in
`packages/` not in `docs/`. It belongs in the same PR that adds
the Dockerfile because the Dockerfile depends on the bin entry.

### Proposed `Dockerfile.glama` for the listing

The MCP server is a Node ESM package; Glama's health check needs
something that runs on `docker run` and listens on stdio for
introspection. The smallest valid Dockerfile:

```dockerfile
# packages/mcp-server/Dockerfile.glama
# Used only for Glama's health-check listing — NOT a production image.
FROM node:20-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/WasmAgent/wasmagent-js.git . \
 && npm install -g bun \
 && bun install \
 && bun run build
WORKDIR /app/packages/mcp-server
# The MCP server reads tools/list & tools/call over stdio.
CMD ["node", "dist/cli.js"]
```

(Verify the CLI entry path before submission — the package may
expose `dist/index.js` instead of `dist/cli.js`. The exact file
to verify: `packages/mcp-server/package.json` `bin` field.)

### Step 2 (mechanical — we can do this once Glama listing exists)

Once `glama.ai/mcp/servers/WasmAgent/wasmagent-js` returns
200, amend [PR
#7910](https://github.com/punkpeye/awesome-mcp-servers/pull/7910)
by editing the entry to:

```markdown
- [WasmAgent/wasmagent-js](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/mcp-server) [![WasmAgent/wasmagent-js MCP server](https://glama.ai/mcp/servers/WasmAgent/wasmagent-js/badges/score.svg)](https://glama.ai/mcp/servers/WasmAgent/wasmagent-js) 📇 ☁️ 🏠 - `@wasmagent/mcp-server`: code-mode MCP server (`execute_code` + `docs_search` two-tool surface) backed by a unified capability manifest across three sandbox kernels (in-process node:vm, WASM via QuickJS / Pyodide / Wasmtime, and remote microVM via E2B / Cloudflare Sandbox). At N=30 tools the bootstrap-context cost drops to 13.6% of direct tool-use. Apache-2.0.
```

The `gh pr edit` command (when Glama listing is live):

```bash
# 1. Update the PR's branch with the amended entry.
git checkout <pr-branch>
$EDITOR README.md   # apply the line above
git commit -am "Add Glama badge per maintainer-bot request"
git push
# 2. Reply on the PR thread:
gh pr comment 7910 --repo punkpeye/awesome-mcp-servers --body "Listed at glama.ai/mcp/servers/WasmAgent/wasmagent-js and added the score badge per the listing-bot request."
```

## 2. `mastra-ai/mastra#17884` — explicit decline

Status: 🔴 CLOSED. **Do not re-open.** See README.md "Maintainer
responses" for the strategic interpretation.

Action: none in this repo, none in Mastra. The interpretive
write-up is logged in `README.md`; that is the artefact.

A future re-pitch is conditional on a public benchmark number
landing first (Direction 2). The trigger is documented; the
draft is not prepared in advance because that would risk a
premature re-open.

## 3. `vercel/ai#16063` — open, no response

Status: 🟡 OPEN.

Action: **wait**. The issue requested a content-shape decision
before opening a PR; pinging too early is impolite. If 30 days
elapse with no maintainer response (i.e. on or after
2026-07-12), post **one** brief follow-up:

```markdown
Friendly bump — no rush, just flagging this is still relevant
on our end. Happy to go any of the three shapes you prefer
(`examples/sandboxed-tools/`, a cookbook entry, or skip).
```

Then resume waiting. Do not bump twice.

## 4. `cloudflare/agents` — pre-submission gate

Status: 🟢 **gate cleared 2026-06-13.**

The pre-submission requirement (`WasmAgentCodemodeExecutor` shim in
`@wasmagent/aisdk` so the recipe in
[`cloudflare-codemode-byo-executor.md`](cloudflare-codemode-byo-executor.md)
actually runs) is now met. The shim ships in
`packages/aisdk/src/codemodeExecutor.ts` with 14 unit tests
covering construction validation, flat-Record providers, namespaced
`ResolvedProvider[]`, positional vs object args, `console.*`
capture, tool-throw surfacing, unknown-tool fail-fast, and
`maxIterations` bounds. Conforms to the cloudflare codemode
`Executor` contract structurally (no `@cloudflare/codemode` import,
to keep the aisdk package consumer-bundle-clean).

Next concrete action: file the recipe-page PR against
`cloudflare/agents`. The PR body uses the draft text in
[`cloudflare-codemode-byo-executor.md`](cloudflare-codemode-byo-executor.md);
the only change before submission is to update the import in the
example from "shim is in flight" to "shipping in
`@wasmagent/aisdk@0.1.x` on npm" (verify version on npm at PR
time).

## How this file is updated

When any of the four resolves (PR merged, issue closed, bump
sent), the matching section is collapsed and a one-line summary
is added to `README.md`'s submission record. The historical
detail stays here.
