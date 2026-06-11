---
"@agentkit-js/core": minor
"@agentkit-js/a2a": minor
"@agentkit-js/ag-ui": minor
"@agentkit-js/agent-prompts": minor
"@agentkit-js/cli": minor
"@agentkit-js/devtools": minor
"@agentkit-js/kernel-pyodide": minor
"@agentkit-js/kernel-quickjs": minor
"@agentkit-js/kernel-remote": minor
"@agentkit-js/kernel-wasmtime": minor
"@agentkit-js/mcp-server": minor
"@agentkit-js/model-anthropic": minor
"@agentkit-js/model-deepseek": minor
"@agentkit-js/model-doubao": minor
"@agentkit-js/model-minimax": minor
"@agentkit-js/model-moonshot": minor
"@agentkit-js/model-openai": minor
"@agentkit-js/model-qwen": minor
"@agentkit-js/model-zhipu": minor
"@agentkit-js/otel-exporter": minor
"@agentkit-js/react": minor
"@agentkit-js/tools-browser": minor
"@agentkit-js/tools-rag": minor
"@agentkit-js/tools-web": minor
"@agentkit-js/ui-cards": minor
"@agentkit-js/ui-cards-react": minor
---

First public npm release.

- All 26 publishable packages now carry standard npm metadata: `repository`,
  `homepage`, `bugs`, `engines`, `license` (Apache-2.0), `publishConfig`,
  per-package `LICENSE`, and a `files` whitelist.
- Inter-package dependencies still use `workspace:*` in source — `changeset publish` rewrites them to semver at pack time.
- `@agentkit-js/cloudflare-worker` remains private and ships only via Workers deploy.
