# wasmagent-js

[![npm version](https://img.shields.io/npm/v/@wasmagent/core.svg?label=%40wasmagent%2Fcore)](https://www.npmjs.com/package/@wasmagent/core)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/WasmAgent/wasmagent-js/actions/workflows/ci.yml/badge.svg)](https://github.com/WasmAgent/wasmagent-js/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-vitepress-brightgreen.svg)](https://WasmAgent.github.io/wasmagent-js/)

**WasmAgent's runtime compliance source of truth.**

Three things, one loop:

```
1. Portable code execution runtime    — sandboxed, framework-neutral
2. Uniform governance surface         — policy, capability, guardrails
3. Verifiable rollout and compliance  — ComplianceEvalRecord, data loop
```

```
wasmagent-js  ──►  bscode        ──►  trace-pipeline  ──►  better models
(runtime /         (reference          (measurement /           │
 policy / AEP)      deployment /        training data)           │
                    evidence)                                     │
      ◄──────────────────────────────────────────────────────────┘
```

> This repository is the **first layer** of the WasmAgent Trustworthy Agent Training Loop.
> Full system diagram: [trace-pipeline/docs/ecosystem-map.md](https://github.com/WasmAgent/trace-pipeline/blob/main/docs/ecosystem-map.md)

> **WasmAgent 0.1: Evidence Layer for MCP Agents**  
> Wrap any MCP server, enforce policy before tool execution, and export verifiable evidence after every agent run.

```bash
npm install @wasmagent/mcp-gateway @wasmagent/aep
```

## Core Runtime
`@wasmagent/core` · `@wasmagent/kernel-quickjs` · `@wasmagent/kernel-pyodide` · `@wasmagent/kernel-remote`

## Integrations
`@wasmagent/aisdk` · `@wasmagent/mastra-sandbox` · `@wasmagent/openai-agents` · `@wasmagent/claude-agent-sdk` · `@wasmagent/mcp-server`

## Compliance / Data
`@wasmagent/compliance` · `@wasmagent/evals-runner` · `@wasmagent/devtools` · rollout-wire schema

## Security & Governance *(alpha)*
`@wasmagent/mcp-firewall` · `@wasmagent/mcp-gateway` · `@wasmagent/mcp-policy` · `@wasmagent/mcp-attestation` · `@wasmagent/capability-compiler`

## Evidence Protocol *(alpha)*
`@wasmagent/aep` — Agent Evidence Protocol: AEP records, AEPEmitter, BudgetLedger, run provenance

> Full package list: [docs/packages.md](docs/packages.md)

---

## Quickstart

Three paths — pick the one that fits your use case:

### Path 1 — Sandboxed code execution

```bash
npm install @wasmagent/aisdk @wasmagent/kernel-quickjs
```

```ts
import { sandboxedJsTool } from "@wasmagent/aisdk";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

// Drop into any AI SDK / LangChain / OpenAI Agents setup
const codeTool = sandboxedJsTool({ kernel: new QuickJSKernel() });
```

→ [Kernel comparison](./docs/kernels/comparison.md) · [Getting started](./docs/guides/getting-started.md)

### Path 2 — MCP runtime firewall

Wrap any MCP server: vet tools before execution, enforce policy per call, track taint across results.

```bash
npm install @wasmagent/mcp-firewall
```

```ts
import { vetTool, evaluatePolicy, taintObservation, snapshotTool } from "@wasmagent/mcp-firewall";

// Before calling a tool
const snap     = snapshotTool(entry, "my-server");   // hash descriptor at registration
const vetting  = vetTool(entry);                     // static scan: injection / exfil / rug-pull
const decision = evaluatePolicy(entry.name, args, vetting, consentRecords);

if (decision.decision === "deny")   throw new Error(`Blocked: ${decision.reason}`);
if (decision.decision === "ask_user") {
  // surface consent UI, then call recordConsent(...)
}

// After receiving result
const obs = taintObservation(entry.name, rawResult);  // boundary-tagged, safe to assemble into prompt
```

→ [Security pack](./docs/security-governance-pack/README.md) · [OWASP Agentic Top 10](./docs/security/capability-manifest-owasp.md) · [Attack demos](./docs/security/mcp-firewall-attack-demos.md)

### Path 3 — Evidence export (AEP)

Emit a signed evidence record after every agent run — consumable by trace-pipeline for audit and training.

```bash
npm install @wasmagent/aep
```

```ts
import { AEPEmitter } from "@wasmagent/aep";

const emitter = new AEPEmitter({ run_id: "run-001", model_id: "claude-sonnet-4-6" });

// During the run — add tool call evidence
emitter.addAction({ tool_name: "bash", outcome: "pass", exit_code: 0 });

// At the end — emit the record
const record = emitter.build();
// record satisfies aep/v0.1 JSON Schema — ready for evomerge validate-aep
```

→ [AEP schema](./packages/aep/) · [trace-pipeline 10-min tutorial](https://github.com/WasmAgent/trace-pipeline/blob/main/docs/TRACE_TO_TRAINING_10MIN.md)

---

📚 **[Docs](https://WasmAgent.github.io/wasmagent-js/)** · [Getting started](./docs/guides/getting-started.md) · [Kernels](./docs/kernels/comparison.md) · [OWASP governance](./docs/security/capability-manifest-owasp.md) · [Security pack](./docs/security-governance-pack/README.md) · [Changelog](./CHANGELOG.md)

---

## WasmAgent Ecosystem

WasmAgent is a portable, governable agent runtime for safe code execution, verifiable rollouts, and post-training data loops.

| Repo | Role |
|---|---|
| **wasmagent-js** (this repo) | Embedded Agent Runtime / WASM Kernel / policy / verifier / adapters |
| [bscode](https://github.com/WasmAgent/bscode) | Cloudflare flagship demo and deploy template for safe coding agents |
| [trace-pipeline](https://github.com/WasmAgent/trace-pipeline) | Public datafactory and eval-trust backend for rollout data |

```text
Task → Safe Runtime → Verifiable Rollout → Trajectory Export → DPO/PPO Data → Better Models
```

---

## What makes wasmagent different

Three wedges where wasmagent stands apart from generic agent frameworks:

| Wedge | What it means |
|---|---|
| **Sandboxed execution** | Three isolation tiers — VmKernel / WASM (QuickJS·Pyodide·Wasmtime) / microVM — with a single `CapabilityManifest` and MCP runtime firewall across all |
| **Runtime compliance** | `TaskSpec` → `ConstraintIR` → `ComplianceEvalRecord` — every run produces an auditable, cross-repo training contract, not just a log |
| **Trace-to-training contract** | Verifiable rollout branching, objective scoring, DPO/PPO export — the loop from runtime evidence to training data is first-class, not an afterthought |

<details>
<summary>Full feature axis table (10 axes vs. other JS agent frameworks)</summary>

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
| 10 | **MCP runtime firewall** — `@wasmagent/mcp-firewall`: descriptor snapshot, static vetting (injection / exfiltration / rug-pull / taint), per-call policy, consent ledger | shipped 2026-06-25 |

</details>

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

# Agent runs
wasmagent run "What is the square root of 144?"
wasmagent run "Summarise AI news" --stream | jq .

# Rollout / training data
wasmagent rank-rollout rollouts.jsonl --out ranked.jsonl
wasmagent validate-rollouts ranked.jsonl
wasmagent export-rollouts --in ranked.jsonl --format dpo --out dpo.jsonl

# MCP security (scan → guard → evidence)
wasmagent init --guard               # generate wasmagent.policy.yaml
wasmagent scan-mcp tools.json        # static risk scan, exits 1 on critical findings
wasmagent guard --config wasmagent.policy.yaml --upstream tools.json
wasmagent evidence export --input aep-records.jsonl --format json
```

**GitHub Action** — enforce policy in CI:

```yaml
- uses: WasmAgent/wasmagent-js/.github/actions/agent-evidence-gate@main
  with:
    policy: wasmagent.policy.yaml
    tools-file: mcp-tools.json
    fail-on-policy-violation: "true"
```

→ [MCP Guard guide](./docs/guides/mcp-guard.md) · [Attack demos](./docs/security/mcp-firewall-attack-demos.md)

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
| API stability policy | [docs/api/stability-policy.md](./docs/api/stability-policy.md) |
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

## Ecosystem

| Project | Role |
|---|---|
| [bscode](https://github.com/WasmAgent/bscode) | Flagship Cloudflare deploy template — wires every wasmagent-js capability into a real edge product |
| [trace-pipeline](https://github.com/WasmAgent/trace-pipeline) | Training data factory — converts ranked rollouts into DPO/PPO datasets |

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
