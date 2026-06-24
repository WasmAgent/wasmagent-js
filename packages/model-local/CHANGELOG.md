# @agentkit-js/model-local

## 1.0.3

### Patch Changes

- [`ac58faa`](https://github.com/WasmAgent/wasmagent-js/commit/ac58faa7948f91defa979dc1f5e37fa8ee66d847) Thanks [@telleroutlook](https://github.com/telleroutlook)! - Brand, schema, tier metadata, adapter quickstarts, security defaults, eval-trust report generator

  - Rename all `AGENTKIT_*` env vars → `WASMAGENT_*` (model-local)
  - Add `objective_status: 'pass'|'fail'|'unknown'` to rollout-wire schema
  - Add `wasmagent.{tier,stability}` maintenance tier metadata to all 33 packages
  - Add `docs/api/stability-policy.md` and `stable-exports.md` (275 stable exports)
  - Add `Before / After` diff + `Security demo` sections to 5 adapter READMEs
  - Add 5 quickstart example directories (aisdk, mastra-sandbox, openai-agents, claude-agent-sdk, mcp-server)
  - Add `scripts/check-release-cadence.mjs` CI gate
  - Add `scripts/e2e-data-loop.mjs` end-to-end pipeline validation script
  - README first screen: three-layer product structure (Core Runtime / Integrations / Trust Data)
  - CHANGELOG: three-tier format (Stable / Beta / Experimental)

- Updated dependencies [[`ac58faa`](https://github.com/WasmAgent/wasmagent-js/commit/ac58faa7948f91defa979dc1f5e37fa8ee66d847)]:
  - @wasmagent/core@1.0.3

## 1.0.0

### Patch Changes

- Updated dependencies []:
  - @wasmagent/core@1.0.0

## 0.1.0

### Minor Changes

- Initial release. Embedded local-LLM adapter for [agentkit-js](https://github.com/telleroutlook/agentkit-js).

  - **`LocalModel`** — implements `Model` against `node-llama-cpp` (optional peer); three constructor sources (`{ path }` / `{ model }` / `{ url }`); GPU/threads/contextSize hints forwarded; capabilities advertise `localEndpoint:true`, `metered:false`, `supportsGrammar:true`.
  - **Multi-mirror registry + downloader** — Qwen 3.5 0.8B / Qwen 3 0.6B / Gemma 3 1B / Llama 3.2 1B registered with HuggingFace + hf-mirror + ModelScope sources. sha256-anchored, atomic writes, env-var (`AGENTKIT_MODEL_MIRROR` / `AGENTKIT_MODEL_DIR`) and programmatic mirror selection, custom CDN URL prefix support.
  - **Grammar-constrained tool calling** — JSON Schema → grammar via `node-llama-cpp` for 100% structurally legal `tool_use` output on sub-1B models. Falls back to free-form when grammar can't be created.
  - **Routing presets** — `localFirst()`, `offlineOnly()`, `devLocalOr()` — thin wrappers over `@agentkit-js/core`'s `FallbackModel`, no parallel mechanism.
  - **CLI** — `agentkit model list/pull/verify/rm`, dynamic-imported so users without the local-LLM peer see no extra weight.
  - **Cert harness** — `examples/benchmarks/local-model-cert.mjs` runs tool-form / tool-semantic / bilingual-instruction / CodeAgent dimensions; `--self-test` verifies the harness itself in CI without a real model.
  - **62 unit tests** across registry, downloader (mocked-fetch multi-mirror failover, sha256 verify, cache hit, atomic write), grammar (extract/build/parse), `LocalModel.generate` (free-form & tool modes via stub), and presets.
