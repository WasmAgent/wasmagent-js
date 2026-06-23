# Upstream PR Tracking

Status of WasmAgent integration submissions to external ecosystems.

| Ecosystem | Target | PR/Issue | Status | Example | Notes |
|---|---|---|---|---|---|
| Vercel AI SDK | examples/sandbox-execution | Draft | In progress | examples/recipes/vercel-ai-sdk/ | sandboxedJsTool via @wasmagent/aisdk |
| Mastra | docs/integrations | Draft | In progress | examples/recipes/mastra-sandbox/ | createMastraSandbox provider |
| OpenAI Agents JS | examples/code-execution | Draft | In progress | examples/recipes/openai-agents/ | sandboxedJsAgentTool |
| Claude Agent SDK | examples/sandbox | Draft | In progress | examples/recipes/claude-agent-sdk/ | sandboxedJsClaudeTool |
| MCP ecosystem | docs/servers | Draft | In progress | examples/recipes/mcp-code-mode/ | createCodeModeServer two-tool surface |
| Cloudflare Workers | templates | Draft | In progress | examples/cf-production/ | deploy template |
| Awesome MCP Servers | README.md | Draft | In progress | docs/strategy/upstream-prs/awesome-mcp-servers-frameworks-entry.md | framework entry |

## How to submit

1. Create the example/recipe in `examples/recipes/<framework>/`
2. Add to this table with status `Draft`
3. Write the upstream PR targeting their examples/docs
4. Link the PR here once submitted
5. Update status to `Merged` when accepted

## Docs strategy

Each recipe follows the template in `docs/recipes/` — 10-line integration, capability manifest, run command, trace export note.
