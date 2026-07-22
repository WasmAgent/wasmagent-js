# wasmagent-js

[![npm version](https://img.shields.io/npm/v/@wasmagent/core.svg?label=%40wasmagent%2Fcore)](https://www.npmjs.com/package/@wasmagent/core)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/WasmAgent/wasmagent-js/actions/workflows/ci.yml/badge.svg)](https://github.com/WasmAgent/wasmagent-js/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-vitepress-brightgreen.svg)](https://WasmAgent.github.io/wasmagent-js/)

> **WasmAgent adds a verifiable evidence layer to agent tool use: protect tool calls, record what happened, audit the result, and admit trusted traces into downstream systems.**

**Protect → Record → Audit → Admit**  ·  **Sync** — agent↔UI shared state

---

## Start in 30 seconds

Pick your entry point:

| Goal | Install |
|---|---|
| **Protect tools** — runtime firewall, policy enforcement, taint tracking | `npm add @wasmagent/mcp-firewall` |
| **Record evidence** — signed AEP records after every agent run | `npm add @wasmagent/aep` |
| **Admit from traces** — compliance scoring produces `ComplianceEvalRecord`s for downstream training | `npm add @wasmagent/aep @wasmagent/compliance` |
| **Sync state** — reducer-backed agent↔UI shared state, agent reads projections + writes intent | `npm add @wasmagent/core` (`/shared-state` subpath) |

**Trust Pack — 30-minute end-to-end: [docs/quickstarts/trust-pack-30min.md](./docs/quickstarts/trust-pack-30min.md)**

---

## Quickstart

Three paths — pick the one that fits your use case:

### Path 1 — Protect: MCP runtime firewall

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

### Path 2 — Record: AEP evidence export

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

### Path 3 — Execute: Sandboxed code execution

Run agent-generated code in an isolated WASM kernel — no host-process access.

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

### Path 4 — Sync: Human-agent shared state

Reducer-backed collaborative state where the LLM reads projections, dispatches semantic actions, and respects affordances — all through standard tools.

```bash
npm install @wasmagent/core
```

```ts
import { defineStateModel, SharedStateStore, stateTools } from "@wasmagent/core/shared-state";

// 1. One reducer, shared by both UI and agent.
const model = defineStateModel({
  initial: () => ({ page: "list", selectedId: null as string | null }),
  reduce: (s, a) => {
    if (a.type === "SELECT") return { ...s, page: "detail", selectedId: a.id };
    if (a.type === "BACK")   return { ...s, page: "list", selectedId: null };
    return s;
  },
  project: (s) => ({ page: s.page, selectedId: s.selectedId }),
  affordances: (s) => s.page === "list" ? ["SELECT"] : ["BACK"],
});

// 2. Server-side store keyed by session.
const store = new SharedStateStore(model);

// 3. Give the agent read_state + dispatch_action tools.
const tools = stateTools(store, "session-001");
// Pass `tools` to any ToolCallingAgent — the LLM reads state and dispatches intent.
```

The semantic action stream doubles as AEP evidence — every dispatch is a provenance-ready record (see [#141](../../issues/141) for the full confluence design).

---

📚 **[Docs](https://WasmAgent.github.io/wasmagent-js/)** · [Getting started](./docs/guides/getting-started.md) · [Kernels](./docs/kernels/comparison.md) · [OWASP governance](./docs/security/capability-manifest-owasp.md) · [Security pack](./docs/security-governance-pack/README.md) · [Changelog](./CHANGELOG.md)

---

## What is shipped vs alpha

WasmAgent uses a five-tier maturity scale to prevent "shipped" from becoming a vague claim:

| Tier | Meaning | Semver guarantee | Production use |
|---|---|---|---|
| **stable** | Public API locked; breaking changes require major-version bump | Yes | Yes |
| **beta** | Functional and used in production, but a specific limitation is documented (e.g. first-line filter only, contract still evolving) | Minor/patch only | Yes, with caveats documented |
| **alpha** | Schema versioned; fields may be added without a breaking-change bump | No | Informed use |
| **demo** | Demonstration or example code; not hardened for production | No | No |
| **research** | Research-grade prototype; interfaces may change without notice | No | No |

Packages not listed here (model adapters, UI cards, etc.) follow the same scale — see each package's README or `package.json` `wasmagent.stability` field.

---

## Package maturity

| Package | Maturity | Notes |
|---|---|---|
| `@wasmagent/core` | **stable** | Public API; semver guaranteed |
| `@wasmagent/kernel-quickjs` | **stable** | |
| `@wasmagent/kernel-remote` | **stable** | |
| `@wasmagent/mcp-gateway` | **stable** | Published 0.1.0; gateway composes all firewall layers |
| `@wasmagent/mcp-firewall` | **beta** | First-line filter, not adversarial-grade — keyword bag + lightweight n-gram classifier; use defence-in-depth |
| `@wasmagent/aep` | **beta** | v0.2 signature contract (Ed25519) shipped; schema versioned |
| `@wasmagent/otel-exporter` | **alpha** | GENAI_SEMCONV, AEP↔OTel bridge |
| `@wasmagent/aisdk` / `@wasmagent/mastra-sandbox` | **alpha** | API stable, may add fields |
| `@wasmagent/compliance` | **alpha** | Schema versioned; may add fields without breaking |
| `@wasmagent/mcp-policy` | **alpha — private** | Not yet published to npm |
| `@wasmagent/mcp-attestation` | **alpha — private** | Not yet published to npm |
| `@wasmagent/evals-runner` | **alpha** | |
| `@wasmagent/devtools` | **alpha** | |

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
| Shared state — reducer-backed agent↔UI sync, projections, affordances | [packages/core/src/shared-state/](./packages/core/src/shared-state/) |
| MCP firewall — vetTool, ScopeLease, ApprovalReceipt | [docs/guides/mcp-guard.md](./docs/guides/mcp-guard.md) |
| AEP v0.2 evidence — causal chain, scope lease, taint, memory refs | [packages/aep/src/types.ts](./packages/aep/src/types.ts) |
| OWASP MCP Top 10 crosswalk | [docs/security/standards-crosswalk.yaml](./docs/security/standards-crosswalk.yaml) |
| OWASP security demo (10 scenarios) | [examples/owasp-demo/](./examples/owasp-demo/) |
| Security benchmark runner | [examples/security-benchmark/](./examples/security-benchmark/) |
| AEP ↔ OTel bidirectional mapping | [packages/otel-exporter/src/aep-otel-bridge.ts](./packages/otel-exporter/src/aep-otel-bridge.ts) |
| AgentTeam delegation chain | [packages/core/src/agents/AgentTeam.ts](./packages/core/src/agents/AgentTeam.ts) |
| Claim dashboard | `node scripts/verify-claims.mjs --html` → `docs/claims/claims.html` |
| Quality runners (self-consistency, reflect-refine, parallel fork-join) | [docs/guides/quality-runners.md](./docs/guides/quality-runners.md) |
| Durable runtime (checkpoints, SSE resume, HITL) | [docs/guides/durable-runtime.md](./docs/guides/durable-runtime.md) |
| Observational memory — ~22% tokens on 50-turn traces | [docs/guides/observational-memory.md](./docs/guides/observational-memory.md) |
| Goal-directed agent with verifiers | [docs/guides/goal-directed.md](./docs/guides/goal-directed.md) |
| Production APIs (retry, evals, OTel, React hook) | [docs/api/production-apis.md](./docs/api/production-apis.md) |
| API stability policy | [docs/api/stability-policy.md](./docs/api/stability-policy.md) |

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
