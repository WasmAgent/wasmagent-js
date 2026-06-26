# Upstream PR Strategy

## Goal

Position WasmAgent as the evidence layer that other agent frameworks can opt into.
Each PR adds `@wasmagent/mcp-firewall` or `@wasmagent/aep` as an optional integration.

## Target Repositories

### Priority 1: MCP Registry

- **What**: Add WasmAgent to the official MCP server registry
- **PR**: Add wasmagent-guard as a recommended MCP proxy/firewall server
- **Value**: Discoverability for MCP users

### Priority 2: Claude SDK / Anthropic cookbook

- **What**: Add example showing AEP evidence + mcp-firewall with Anthropic tools
- **PR**: `examples/wasmagent-evidence-layer/`
- **Value**: Reaches Anthropic SDK users directly

### Priority 3: Vercel AI SDK

- **What**: Add WasmAgent MCP firewall as middleware example
- **PR**: `examples/mcp-security/wasmagent-guard.ts`
- **Value**: Large Next.js/Vercel developer audience

### Priority 4: Mastra

- **What**: Integration example showing wasmagent-js evidence recording
- **PR**: `packages/mastra-sandbox` already exists in wasmagent-js; add Mastra example
- **Value**: Mastra is growing agent framework

### Priority 5: LangChainJS

- **What**: Add wasmagent AEP as a tracer/callback option
- **PR**: `docs/integrations/wasmagent-aep`
- **Value**: Largest agent framework ecosystem

## Template PR Description

Include in every PR:

- One-sentence value: "WasmAgent adds deterministic MCP firewall + signed AEP evidence to every tool call"
- Link to `standards-crosswalk.yaml`
- Link to bscode live demo
- Link to trace-pipeline audit report example

## Checklist per PR

- [ ] `package.json` peer dep is optional (`wasmagent/mcp-firewall` as optional dep)
- [ ] No breaking changes to host framework
- [ ] Example is self-contained and runnable
- [ ] Links to wasmagent-js README
