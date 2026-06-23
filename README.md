# wasmagent

**Embedded Agent Runtime — WASM sandboxing, capability governance, verifiable rollouts**

[![npm version](https://img.shields.io/npm/v/@wasmagent/core.svg?label=%40wasmagent%2Fcore)](https://www.npmjs.com/package/@wasmagent/core)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/WasmAgent/wasmagent-js/actions/workflows/ci.yml/badge.svg)](https://github.com/WasmAgent/wasmagent-js/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-vitepress-brightgreen.svg)](https://WasmAgent.github.io/wasmagent-js/)

**Bring your own agent framework.** wasmagent-js provides the sandboxed runtime, capability policies, build/visual verifiers, rollout ranker, and trace export — without replacing your existing orchestration.

```bash
npm add @wasmagent/core @anthropic-ai/sdk
```

```ts
import { ToolCallingAgent, AnthropicModel } from "@wasmagent/core";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { sandboxedJsTool } from "@wasmagent/aisdk";

const agent = new ToolCallingAgent({
  model: new AnthropicModel("claude-haiku-4-5-20251001"),
  tools: [sandboxedJsTool({ kernel: new QuickJSKernel() })],
});

for await (const ev of agent.run("Calculate the first 10 Fibonacci numbers.")) {
  if (ev.event === "final_answer") console.log(ev.data.answer);
}
```

📚 **[Docs](https://WasmAgent.github.io/wasmagent-js/)** · [Getting started](./docs/guides/getting-started.md) · [Kernels](./docs/kernels/comparison.md) · [OWASP governance](./docs/security/capability-manifest-owasp.md) · [Security pack](./docs/security-governance-pack/README.md) · [Changelog](./CHANGELOG.md)

---

## WasmAgent Ecosystem

WasmAgent is a portable, governable agent runtime for safe code execution, verifiable rollouts, and post-training data loops.

| Repo | Role |
|---|---|
| **wasmagent-js** (this repo) | Embedded Agent Runtime / WASM Kernel / policy / verifier / adapters |
| [bscode](https://github.com/WasmAgent/bscode) | Cloudflare flagship demo and deploy template for safe coding agents |
| [evomerge](https://github.com/WasmAgent/evomerge) | Public datafactory and eval-trust backend for rollout data |

```text
Task → Safe Runtime → Verifiable Rollout → Trajectory Export → DPO/PPO Data → Better Models
```

---

## What makes wasmagent different

Nine axes where wasmagent does something other JS frameworks don't — all in one package:

| # | Axis | Status |
|---|---|---|
| 1 | **Multi-provider adapters** — one `Model` interface across Anthropic, OpenAI, Doubao, DeepSeek, Kimi, Qwen, GLM, MiniMax, local llama.cpp | shipped |
| 2 | **Three isolation tiers** — `VmKernel` (in-process) / QuickJS·Pyodide·Wasmtime (WASM) / `RemoteSandboxKernel` (microVM) — same `CapabilityManifest` across all | shipped |
| 3 | **Cross-runtime + offline** — Node / edge / browser / air-gapped laptop; `@wasmagent/model-local` + WASM kernel = zero outbound traffic | shipped |
| 4 | **Memory layers** — `MemoryBlockSet` (prompt-cache stable) + observational memory + Checkpointer + 4 KV backends | shipped |
| 5 | **Durable workflows** — `LocalWorkflowEngine` + `CloudflareWorkflowEngine` — observable, terminable, resumable | shipped |
| 6 | **Code-mode MCP** — N tools → 2 tools (`docs_search` + `execute_code`); 13.6% token cost at N=30 | shipped |
| 7 | **Devtools + OTel** — local Studio, `gen_ai.*` semantic conventions (Datadog / Honeycomb / Grafana) | shipped |
| 8 | **Goal-directed loop** — agent synthesises success criteria, verifies, retries with hints | shipped 2026-06-18 |
| 9 | **Adaptive execution** — registered fallbacks (L1) → synthesised tool (L2) → relaxed goal (L3) | shipped 2026-06-18 |

> Full comparison with Vercel AI SDK, LangGraph.js, OpenAI Agents JS, Mastra, CF Agents SDK: **[docs/compare.md](./docs/compare.md)**

---

## Quick Start

### Tool-Calling Agent

```ts
import { ToolCallingAgent, AnthropicModel } from "@wasmagent/core";
import { z } from "zod";

const agent = new ToolCallingAgent({
  model: new AnthropicModel("claude-haiku-4-5-20251001"),
  tools: [{
    name: "search", description: "Search the web",
    inputSchema: z.object({ query: z.string() }),
    readOnly: true, idempotent: true,
    forward: async ({ query }) => `Results for: ${query}`,
  }],
  stopPolicies: ["steps:10", "cost:0.5"],
});

for await (const ev of agent.run("Search for recent AI news")) {
  if (ev.event === "final_answer") console.log(ev.data.answer);
}
```

### Sandboxed Code Agent

```ts
import { CodeAgent, AnthropicModel } from "@wasmagent/core";

const agent = new CodeAgent({
  model: new AnthropicModel("claude-sonnet-4-6"),
  tools: [],  // kernel executes code; no extra tools needed
  maxSteps: 10,
});

for await (const ev of agent.run("What is 42 * 1337?")) {
  if (ev.event === "final_answer") console.log(ev.data.answer);
}
```

### CLI

```bash
npm install -g @wasmagent/cli

wasmagent run "What is the square root of 144?"
wasmagent run "Summarise AI news" --stream | jq .
wasmagent rank-rollout rollouts.jsonl --out ranked.jsonl
wasmagent validate-rollouts ranked.jsonl
wasmagent export-rollouts --in ranked.jsonl --format dpo --out dpo.jsonl
```

---

## Key Capabilities

| Capability | Guide |
|---|---|
| Quality runners (self-consistency, reflect-refine, budget forcing, parallel fork-join) | [docs/guides/quality-runners.md](./docs/guides/quality-runners.md) |
| Durable runtime (checkpoints, SSE resume, HITL across processes) | [docs/guides/durable-runtime.md](./docs/guides/durable-runtime.md) |
| Observational memory — ~22% tokens on 50-turn traces | [docs/guides/observational-memory.md](./docs/guides/observational-memory.md) |
| Goal-directed agent with verifiers | [docs/guides/goal-directed.md](./docs/guides/goal-directed.md) |
| Super-Instruction Set (SI-1~9) — composable agent patterns | [docs/guides/super-instruction-set.md](./docs/guides/super-instruction-set.md) |
| Production APIs (retry, evals, OTel, React hook, PTC) | [docs/api/production-apis.md](./docs/api/production-apis.md) |
| Kernel selection decision tree | [docs/kernels/comparison.md](./docs/kernels/comparison.md) |
| Security governance + OWASP Agentic Top 10 | [docs/security-governance-pack/README.md](./docs/security-governance-pack/README.md) |
| RLAIF data loop (rollout → DPO/PPO) | [docs/schemas/GOVERNANCE.md](./docs/schemas/GOVERNANCE.md) |
| Adapter recipes (Vercel AI SDK, Mastra, OpenAI Agents, Claude SDK, MCP) | [docs/recipes/](./docs/recipes/) |

---

## Model Providers

First-class adapters: Anthropic · OpenAI · Doubao · DeepSeek · Kimi · Qwen · GLM · MiniMax · local llama.cpp

```ts
// Chinese providers with thinking support
import { DoubaoModel, DoubaoModels } from "@wasmagent/model-doubao";
import { DeepSeekModel, DeepSeekModels } from "@wasmagent/model-deepseek";

// Local / offline
import { LocalModel } from "@wasmagent/model-local";  // node-llama-cpp, multi-mirror download
```

Full provider reference and proxy/custom endpoint setup: [docs/guides/openai-compat-recipes.md](./docs/guides/openai-compat-recipes.md)

---

## Packages

wasmagent is a 33-package monorepo. See **[docs/packages.md](docs/packages.md)** for the tier-classified list with one-line descriptions and README links.

---

## Ecosystem

| Project | Role |
|---|---|
| [bscode](https://github.com/WasmAgent/bscode) | Flagship Cloudflare deploy template — wires every wasmagent-js capability into a real edge product |
| [evomerge](https://github.com/WasmAgent/evomerge) | Training data factory — converts ranked rollouts into DPO/PPO datasets |

---

## Development

```bash
bun install && bun run build
bun test packages/
bun run typecheck
bun run bench          # reproduce all README benchmarks
bun run check:branding # CI guard: no old brand references
bun run verify:claims  # CI guard: all benchmark claims have evidence scripts
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) · [Changelog](./CHANGELOG.md) · [License: Apache-2.0](./LICENSE)
