# Packages

wasmagent-js is a 37-package monorepo published under the `@wasmagent/*` scope on npm.

## Maintenance tiers

| Tier | Meaning | Semver guarantee |
|---|---|---|
| **Stable** | Public API frozen; breaking changes require major version | ✅ Full semver |
| **Beta** | API largely stable; minor breaking changes possible with a CHANGELOG entry | Semver best-effort |
| **Alpha** | Schema may gain fields; runtime repair API evolving; schema contract frozen | Schema stable, API in flux |
| **Experimental** | May change or be removed without notice | None |
| **Internal** | Not published to npm | n/a |

| Package | Tier |
|---|---|
| `@wasmagent/core` | Stable |
| `@wasmagent/kernel-quickjs` · `@wasmagent/kernel-pyodide` · `@wasmagent/kernel-wasmtime` · `@wasmagent/kernel-remote` | Stable |
| `@wasmagent/cli` | Stable |
| `@wasmagent/aisdk` · `@wasmagent/mastra-sandbox` · `@wasmagent/mcp-server` | Beta |
| `@wasmagent/model-anthropic` · `@wasmagent/model-openai` · `@wasmagent/model-local` | Beta |
| `@wasmagent/model-doubao` · `@wasmagent/model-deepseek` · `@wasmagent/model-moonshot` · `@wasmagent/model-qwen` · `@wasmagent/model-zhipu` · `@wasmagent/model-minimax` | Beta (best-effort, tied to provider API stability) |
| `@wasmagent/devtools` · `@wasmagent/evals-runner` | Beta |
| `@wasmagent/react` · `@wasmagent/ui-cards` · `@wasmagent/ui-cards-react` | Beta |
| `@wasmagent/otel-exporter` · `@wasmagent/agent-prompts` | Beta |
| `@wasmagent/claude-agent-sdk` · `@wasmagent/openai-agents` · `@wasmagent/a2a` · `@wasmagent/ag-ui` | Beta |
| `@wasmagent/tools-web` · `@wasmagent/tools-rag` · `@wasmagent/tools-browser` | Beta |
| `@wasmagent/compliance` | Alpha (schema contract frozen; repair API evolving) |
| `@wasmagent/aep` | Alpha (schema versioned `aep/v0.1`; emitter API evolving) |
| `@wasmagent/mcp-firewall` · `@wasmagent/mcp-gateway` · `@wasmagent/capability-compiler` | Alpha |
| `@wasmagent/mcp-policy` | Alpha — private (not yet published to npm) |
| `@wasmagent/mcp-attestation` | Alpha — private (not yet published to npm) |
| `@wasmagent/eliza-rollout-plugin` | Experimental |
| `@wasmagent/cloudflare-worker` | Internal |

## Runtime

| Package | What it is |
|---|---|
| [`@wasmagent/core`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/core) | Agents, kernels, models, tools, runners, evals, checkpoints, observability, RLAIF rollout infrastructure |
| [`@wasmagent/cli`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/cli) | `wasmagent` CLI: `run`, `init`, `init-tool`, `devtools`, `evals`, `model`, `goal`, `verify`, `validate-rollouts`, `export-rollouts` |
| [`@wasmagent/devtools`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/devtools) | Time-travel debugger + opt-in React UI + `RunsAggregator` for the local Studio |
| [`@wasmagent/evals-runner`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/evals-runner) | Multi-model multi-suite Pareto evaluation harness; six reference suites; paired statistics (McNemar / Wilson / bootstrap / G1) |
| [`@wasmagent/react`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/react) | `useAgentRun()` SSE streaming hook |
| [`@wasmagent/agent-prompts`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/agent-prompts) | Reusable prompt fragments |
| [`@wasmagent/ui-cards`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/ui-cards) · [`ui-cards-react`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/ui-cards-react) | `\`\`\`card:*` block parser + components |
## Code execution kernels

| Package | Tier | Edge-safe |
|---|---|---|
| [`@wasmagent/kernel-quickjs`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-quickjs) | True WASM | ✅ |
| [`@wasmagent/kernel-pyodide`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-pyodide) | True WASM (Python) | ✅ (heavy) |
| [`@wasmagent/kernel-wasmtime`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-wasmtime) | True WASM via Javy | ✅ |
| [`@wasmagent/kernel-remote`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-remote) | External microVM (E2B / CF Sandbox) | n/a |

See the [kernel decision tree](/kernels/comparison) for picking the right one.

## Models

### Anthropic / OpenAI

| Package | Notes |
|---|---|
| [`@wasmagent/model-anthropic`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-anthropic) | Auto cache breakpoints, 1-hour TTL |
| [`@wasmagent/model-openai`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-openai) | OpenAI / Azure OpenAI |

### Local LLM (offline / privacy / cost)

| Package | Notes |
|---|---|
| [`@wasmagent/model-local`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-local) | `node-llama-cpp` adapter; multi-mirror registry (HF / hf-mirror / ModelScope); JSON-schema grammar; `localFirst` / `offlineOnly` / `devLocalOr` routing presets |

### Chinese model providers

> ⚠️ **Compliance** — read each adapter's README for the provider's terms of service and data-residency notes.

| Package | Provider | Highlights |
|---|---|---|
| [`@wasmagent/model-doubao`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-doubao) | Volcengine Ark | thinking tiers + `ark-context` cache |
| [`@wasmagent/model-deepseek`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-deepseek) | DeepSeek V4 | `thinking:{type,effort}` |
| [`@wasmagent/model-moonshot`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-moonshot) | Moonshot / Kimi | per-version reasoning field |
| [`@wasmagent/model-qwen`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-qwen) | Alibaba DashScope | `enable_thinking` + `thinking_budget` |
| [`@wasmagent/model-zhipu`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-zhipu) | Zhipu GLM-5 | `thinking:{type}` via extra_body |
| [`@wasmagent/model-minimax`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-minimax) | MiniMax M2/M3 | `reasoning_split` + `<think>` tag parsing |

## Tools

| Package | Tools |
|---|---|
| [`@wasmagent/tools-web`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/tools-web) | Tavily, Brave, Perplexity (LRU-cached) |
| [`@wasmagent/tools-rag`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/tools-rag) | `HttpEmbedder`, Pinecone, Qdrant, in-memory |
| [`@wasmagent/tools-browser`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/tools-browser) | Playwright + CDP-bridge sessions, 5 tools |

## Protocol adapters

| Package | Protocol |
|---|---|
| [`@wasmagent/mcp-server`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/mcp-server) | Expose any agent as MCP server; `createCodeModeServer()` for the docs-search + execute-code two-tool surface |
| [`@wasmagent/aisdk`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/aisdk) | Vercel AI SDK 4–6 integration: `sandboxedJsTool()` + `codeModeTool()` |
| [`@wasmagent/mastra-sandbox`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/mastra-sandbox) | Mastra sandbox-provider contract backed by an wasmagent kernel |
| [`@wasmagent/claude-agent-sdk`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/claude-agent-sdk) | Anthropic Claude Agent SDK adapter — wrap an wasmagent kernel as a Claude SDK tool |
| [`@wasmagent/openai-agents`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/openai-agents) | OpenAI Agents JS adapter — `Tool<T>` shape backed by an wasmagent kernel |
| [`@wasmagent/a2a`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/a2a) | A2A (Agent2Agent) inbound + outbound |
| [`@wasmagent/ag-ui`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/ag-ui) | AG-UI inbound transport |

## Observability

| Package | What |
|---|---|
| [`@wasmagent/otel-exporter`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/otel-exporter) | OTLP exporter for `EventLog`; AEP span names (`mcp.request`, `policy.check`, `sandbox.exec`, `verifier.check`, `redaction.apply`, `dataset.export`) + attribute helpers |

## Security & Governance (alpha)

| Package | What it is |
|---|---|
| [`@wasmagent/mcp-firewall`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/mcp-firewall) | Runtime firewall + gateway for MCP: descriptor snapshot, static vetting, per-call policy, taint tracking, consent ledger; **gateway layer**: identity propagation (`RequestIdentity`), server card (`ServerCard`/`buildServerCard`), state-changing action classification (`isStateChangingTool`), `MCPGateway` with AEP evidence refs |
| [`@wasmagent/mcp-gateway`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/mcp-gateway) | MCP Gateway — identity propagation, server card validation, policy enforcement, AEP evidence emission for MCP tool invocations |
| [`@wasmagent/aep`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/aep) | Agent Evidence Protocol — `AEPRecord` / `ActionEvidence` / `CapabilityDecision` types + `AEPEmitter`. Cross-repo public data contract for trace-pipeline training export and compliance audit. Schema: `aep/v0.1` |
| [`@wasmagent/capability-compiler`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/capability-compiler) | Compile `CapabilityManifest` → MCP schema fragment, runtime policy rules, trace validator spec |
| [`@wasmagent/compliance`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/compliance) | TaskSpec-driven verification + local repair for LLM runs; `ComplianceEvalRecord` emitter; IFEval benchmark harness |
| [`@wasmagent/mcp-policy`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/mcp-policy) | **Alpha — not yet published.** Policy bundle DSL for MCP firewall rules. `PolicyBundle` (named, versioned, sha256-addressed collection of `PolicyRule`s) with `extend()`, `static default()`, `static strict()`; re-exports `evaluatePolicy`, `DEFAULT_RULES`, `DENY_BLOCKED_RULE`, `ASK_HIGH_RISK_RULE` from `@wasmagent/mcp-firewall`. API may change without notice. |
| [`@wasmagent/mcp-attestation`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/mcp-attestation) | **Alpha — not yet published.** Capability attestation registry for MCP server identity. Four ordered levels (`self < community < operator < audited`); `CapabilityAttestation` interface (attestationId, serverId, toolManifestDigest, level, capabilities, attestedBy, attestedAt); `AttestationRegistry`, `buildAttestation`, `isAttestationValid`. Full PKI signing via Sigstore can be layered on top. API may change without notice. |

### Alpha packages — not yet published to npm

The following packages are under active development and carry `"private": true` in their
`package.json`. They are available from the monorepo source but are not yet on the npm registry.
Install them via workspace dependency (`"@wasmagent/mcp-policy": "workspace:*"`) or wait for the
first alpha publish via the `publish-alpha` workflow.

#### @wasmagent/mcp-policy

Policy bundle DSL for the WasmAgent MCP firewall. A `PolicyBundle` is a named, versioned,
sha256-content-addressed collection of `PolicyRule`s. Key API:

- `PolicyBundle` — `metadata`, `rules`, `digest`, `extend()`, `static default()`, `static strict()`
- Re-exports from `@wasmagent/mcp-firewall`: `evaluatePolicy`, `DEFAULT_RULES`,
  `DENY_BLOCKED_RULE`, `ASK_HIGH_RISK_RULE`, `PolicyRule`

Related: `@wasmagent/mcp-firewall`, `@wasmagent/mcp-gateway`, `@wasmagent/mcp-attestation`.

#### @wasmagent/mcp-attestation

Capability attestation registry for MCP server identity. Provides a data model and registry for
registering and verifying capability attestations on MCP tools. Key API:

- Four ordered levels: `self < community < operator < audited`
- `hasAttestation(serverId, level)` matches the given level and any higher level
- `CapabilityAttestation` interface — `attestationId`, `serverId`, `toolManifestDigest`, `level`,
  `capabilities`, `attestedBy`, `attestedAt`, optional `expiresAt`/`notes`
- Exports: `buildAttestation`, `isAttestationValid`, `AttestationRegistry`
- Full PKI signing via Sigstore can be layered on top

Related: `@wasmagent/mcp-firewall` (enforcement), `@wasmagent/mcp-policy` (policy bundles),
`@wasmagent/aep` (evidence records).

## Ecosystem integrations (beta)

| Package | What it is |
|---|---|
| [`@wasmagent/eliza-rollout-plugin`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/eliza-rollout-plugin) | elizaOS community plugin — emit `rollout-wire/v1` training records from elizaOS agent runs |

## Internal (not on npm)

- `@wasmagent/cloudflare-worker` — `private: true`. Sample Workers entry point; ships only via `wrangler deploy`.
