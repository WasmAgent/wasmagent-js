# Install Footprint Guide

wasmagent packages are composable — install only what you need.

---

## Package footprint table

| Package | Install size | Edge (Cloudflare Workers) | Notes |
|---|---|---|---|
| `@wasmagent/core` | lightweight | ✅ | No native deps; tree-shake aggressively |
| `@wasmagent/mcp-firewall` | lightweight | ✅ | Pure TypeScript; no native deps |
| `@wasmagent/aep` | lightweight | ✅ | Pure TypeScript; Zod only |
| `@wasmagent/mcp-policy` | lightweight | ✅ | Thin wrapper over mcp-firewall |
| `@wasmagent/mcp-attestation` | lightweight | ✅ | Pure TypeScript |
| `@wasmagent/mcp-gateway` | lightweight | ✅ | Pure TypeScript |
| `@wasmagent/compliance` | lightweight | ✅ | Pure TypeScript |
| `@wasmagent/capability-compiler` | lightweight | ✅ | Pure TypeScript |
| `@wasmagent/otel-exporter` | lightweight | ✅ | HTTP only; no native deps |
| `@wasmagent/evals-runner` | lightweight | ✅ | Pure TypeScript |
| `@wasmagent/kernel-quickjs` | medium (~1 MB) | ✅ | WASM binary included |
| `@wasmagent/kernel-wasmtime` | medium | ❌ Node.js only | Requires Node WebAssembly API |
| `@wasmagent/kernel-pyodide` | heavy (~8 MB+) | ❌ | CPython-in-WASM; too large for Workers |
| `@wasmagent/kernel-remote` | lightweight | ✅ | HTTP only; connects to E2B/Cloudflare |
| `@wasmagent/tools-browser` | heavy | ❌ Node.js only | Requires Playwright |
| `@wasmagent/tools-rag` | medium | ⚠️ partial | Vector DB connectors vary by backend |
| `@wasmagent/tools-web` | lightweight | ✅ | HTTP only |
| `@wasmagent/model-local` | heavy | ❌ Node.js only | node-llama-cpp native bindings |
| `@wasmagent/model-anthropic` | lightweight | ✅ | Thin SDK wrapper |
| `@wasmagent/model-openai` | lightweight | ✅ | Thin SDK wrapper |
| `@wasmagent/model-deepseek` | lightweight | ✅ | Thin SDK wrapper |
| `@wasmagent/model-doubao` | lightweight | ✅ | Thin SDK wrapper |
| `@wasmagent/model-qwen` | lightweight | ✅ | Thin SDK wrapper |
| `@wasmagent/model-zhipu` | lightweight | ✅ | Thin SDK wrapper |
| `@wasmagent/model-minimax` | lightweight | ✅ | Thin SDK wrapper |
| `@wasmagent/model-moonshot` | lightweight | ✅ | Thin SDK wrapper |
| `@wasmagent/aisdk` | lightweight | ✅ | `ai` (Vercel AI SDK) is a peer dep |
| `@wasmagent/mastra-sandbox` | lightweight | ✅ | `@mastra/core` is a peer dep |
| `@wasmagent/openai-agents` | lightweight | ✅ | `@openai/agents` is a peer dep |
| `@wasmagent/claude-agent-sdk` | lightweight | ✅ | `@anthropic-ai/claude-agent-sdk` is a peer dep |
| `@wasmagent/react` | lightweight | ✅ | `react` is a peer dep |

---

## Edge compatibility detail

Packages marked ✅ work in Cloudflare Workers with no special configuration. Packages marked ❌ require a Node.js environment (local, server, or CI). `@wasmagent/kernel-remote` is the recommended isolation layer for edge/serverless deployments.

---

## Optional peer dependencies

Install these only when you use the corresponding adapter:

| Package | Optional peer | When you need it |
|---|---|---|
| `@wasmagent/aisdk` | `ai` | Using the Vercel AI SDK integration |
| `@wasmagent/openai-agents` | `@openai/agents` | Using the OpenAI Agents JS SDK |
| `@wasmagent/claude-agent-sdk` | `@anthropic-ai/claude-agent-sdk` | Using the Anthropic Claude Agent SDK |
| `@wasmagent/mastra-sandbox` | `@mastra/core` | Using Mastra as the agent framework |
| `@wasmagent/tools-browser` | `playwright` | Browser automation tools |
| `@wasmagent/model-local` | `node-llama-cpp` | Running local LLMs without outbound traffic |

---

## Quickstart install footprints

### Trust Pack (minimal — evidence layer only)

```bash
npm add @wasmagent/mcp-firewall @wasmagent/aep
```

~50 KB installed. Covers: tool protection, evidence emission, CI gate.

### Runtime (with sandbox execution)

```bash
npm add @wasmagent/core @wasmagent/kernel-quickjs
```

~1.3 MB installed (includes WASM binary). Covers: sandboxed code execution, tool calling agents.

### Full stack (runtime + evidence + framework adapter)

```bash
npm add @wasmagent/core @wasmagent/kernel-quickjs @wasmagent/mcp-firewall @wasmagent/aep
npm add @wasmagent/aisdk   # or openai-agents / claude-agent-sdk / mastra-sandbox
```

~1.5 MB + framework peer deps. Covers: sandboxed execution, evidence, firewall, framework integration.

### Compliance research

```bash
npm add @wasmagent/compliance @wasmagent/aep @wasmagent/evals-runner
pip install evomerge
```

Covers: constraint verification, evidence export, training data generation.

---

## Model SDK install cost

All model adapters are thin wrappers. The actual SDK is installed once as a direct dep:

```bash
npm add @anthropic-ai/sdk        # for @wasmagent/model-anthropic
npm add openai                   # for @wasmagent/model-openai
# etc.
```

`@wasmagent/model-local` with `node-llama-cpp` downloads model weights separately (not part of npm install). Model weights are typically 1–8 GB and are cached in `~/.cache/node-llama-cpp`.
