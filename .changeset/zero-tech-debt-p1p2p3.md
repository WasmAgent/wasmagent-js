---
"@wasmagent/core": patch
"@wasmagent/aisdk": patch
"@wasmagent/claude-agent-sdk": patch
"@wasmagent/cli": patch
"@wasmagent/cloudflare-worker": patch
"@wasmagent/devtools": patch
"@wasmagent/evals-runner": patch
"@wasmagent/kernel-pyodide": patch
"@wasmagent/kernel-quickjs": patch
"@wasmagent/kernel-remote": patch
"@wasmagent/kernel-wasmtime": patch
"@wasmagent/mastra-sandbox": patch
"@wasmagent/mcp-server": patch
"@wasmagent/model-anthropic": patch
"@wasmagent/model-deepseek": patch
"@wasmagent/model-doubao": patch
"@wasmagent/model-local": patch
"@wasmagent/model-minimax": patch
"@wasmagent/model-moonshot": patch
"@wasmagent/model-openai": patch
"@wasmagent/model-qwen": patch
"@wasmagent/model-zhipu": patch
"@wasmagent/openai-agents": patch
"@wasmagent/otel-exporter": patch
"@wasmagent/react": patch
"@wasmagent/tools-browser": patch
"@wasmagent/tools-rag": patch
"@wasmagent/tools-web": patch
"@wasmagent/ui-cards": patch
"@wasmagent/ui-cards-react": patch
"@wasmagent/agent-prompts": patch
"@wasmagent/a2a": patch
"@wasmagent/ag-ui": patch
---

Brand, schema, tier metadata, adapter quickstarts, security defaults, eval-trust report generator

- Rename all `AGENTKIT_*` env vars → `WASMAGENT_*` (cloudflare-worker, model-local)
- Add `objective_status: 'pass'|'fail'|'unknown'` to rollout-wire schema
- Add `wasmagent.{tier,stability}` maintenance tier metadata to all 33 packages
- Add `docs/api/stability-policy.md` and `stable-exports.md` (275 stable exports)
- Add `Before / After` diff + `Security demo` sections to 5 adapter READMEs
- Add 5 quickstart example directories (aisdk, mastra-sandbox, openai-agents, claude-agent-sdk, mcp-server)
- Add `scripts/check-release-cadence.mjs` CI gate
- Add `scripts/e2e-data-loop.mjs` end-to-end pipeline validation script
- README first screen: three-layer product structure (Core Runtime / Integrations / Trust Data)
- CHANGELOG: three-tier format (Stable / Beta / Experimental)
