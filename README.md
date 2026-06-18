# agentkit-js

[![npm version](https://img.shields.io/npm/v/@agentkit-js/core.svg?label=%40agentkit-js%2Fcore)](https://www.npmjs.com/package/@agentkit-js/core)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/telleroutlook/agentkit-js/actions/workflows/ci.yml/badge.svg)](https://github.com/telleroutlook/agentkit-js/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-vitepress-brightgreen.svg)](https://telleroutlook.github.io/agentkit-js/)
[![Glama MCP server](https://glama.ai/mcp/servers/telleroutlook/agentkit-js/badges/score.svg)](https://glama.ai/mcp/servers/telleroutlook/agentkit-js)

**TypeScript agent runtime with WASM sandboxing, prompt-cache optimization, and parallel quality runners.**

Build production-grade AI agents in TypeScript — code-execution agents, tool-calling agents, or multi-path reasoning pipelines — with built-in cost controls and Cloudflare Workers deployment.

```bash
# For Anthropic (Claude)
npm add @agentkit-js/core @anthropic-ai/sdk

# For OpenAI / compatible endpoints (Ollama, vLLM, etc.)
npm add @agentkit-js/core openai
```

> 📚 **Docs site:** <https://telleroutlook.github.io/agentkit-js/> · **Getting started in 5 min:** [docs/guides/getting-started.md](./docs/guides/getting-started.md) · **Benchmarks:** [docs/benchmarks.md](./docs/benchmarks.md) · **Changelog:** [CHANGELOG.md](./CHANGELOG.md) · **API stability:** [docs/strategy/api-stability.md](./docs/strategy/api-stability.md) · **Strategy memo:** [docs/strategy/2026-06-competitiveness.md](./docs/strategy/2026-06-competitiveness.md) · **Trust Page (D4):** [docs/strategy/trust.md](./docs/strategy/trust.md) · **Enterprise security face:** [docs/strategy/security-face.md](./docs/strategy/security-face.md)
>
> 🆕 **2026-06-17 strategy update:** code-mode is now table stakes (CF / OpenAI / Anthropic all ship it). The differentiation tightened to **portable executor + governance + paired-statistics referee**. New: [`docs/security/capability-manifest-owasp.md`](./docs/security/capability-manifest-owasp.md) (OWASP Agentic Top 10 mapping) · [`docs/strategy/2026-06-17-update.md`](./docs/strategy/2026-06-17-update.md) (delta on top of S1–S4) · [`docs/reports/arm-batch-grammar-2026-06-17/analysis.md`](./docs/reports/arm-batch-grammar-2026-06-17/analysis.md) (worked example: how `evals-runner` falsified our own hypothesis in 30 minutes).
>
> 🎯 **2026-06-18 — `GoalDirectedAgent` shipped.** New first-class loop primitive: agent synthesises its own success criteria, verifies them deterministically (or with adversarial-defaulted LLM judge), retries with hints. The eighth axis of differentiation — see [`docs/guides/goal-directed.md`](./docs/guides/goal-directed.md). One-shot `ToolCallingAgent` is still the default; goal-directed is opt-in for tasks where "did this actually deliver" matters.
>
> 🤝 **Looking for a co-maintainer.** `@agentkit-js/core@1.0.0` is on the calendar for **2026-12-15**. If you ship to the Vercel AI SDK / Mastra / Claude Agent SDK / OpenAI Agents JS / Cloudflare Agents / LangGraph.js communities and want npm-publish + merge rights, see [CONTRIBUTING.md](./CONTRIBUTING.md#looking-for-a-co-maintainer) and [GOVERNANCE.md](./GOVERNANCE.md). Release cadence ledger: [docs/strategy/release-cadence-log.md](./docs/strategy/release-cadence-log.md). Sandbox-escape SLA drill log: [docs/strategy/security-drill-log.md](./docs/strategy/security-drill-log.md).

---

## Nine differentiation axes — at a glance

> **What this table is.** The eight surfaces where agentkit-js is doing
> something the other JS agent frameworks (Vercel AI SDK, OpenAI Agents
> JS, Mastra, LangGraph.js, CF Agents SDK, smolagents-ts) are not — at
> least not all in one place. Each row links to the guide that explains
> it. The detailed feature grid below this section breaks each axis
> into the specific cells where competitors do or don't ship the same
> capability. [Last verified 2026-06-18.]
>
> **🆕 A ninth axis is in flight.** "Adaptive execution" — tool fallback
> when a tool fails, tool synthesis when none fits, goal adaptation
> when the goal turns out unreachable. RFC drafted 2026-06-18, phased
> implementation. See [`docs/strategy/2026-06-18-adaptive-execution.md`](./docs/strategy/2026-06-18-adaptive-execution.md)
> and [`docs/rfcs/adaptive-execution.md`](./docs/rfcs/adaptive-execution.md).

| # | Axis | One-line value | Status | Doc |
|---|------|----------------|--------|-----|
| 1 | **Multi-provider model adapters** | One `Model` interface across Anthropic / OpenAI / Doubao / DeepSeek / Kimi / Qwen / GLM / MiniMax / local node-llama-cpp — bring your own vendor, swap with one line. | shipped | [getting-started](./docs/guides/getting-started.md) · [openai-compat-recipes](./docs/guides/openai-compat-recipes.md) |
| 2 | **Multi-tier kernel matrix** | Three execution tiers (`VmKernel` in-process · `QuickJS`/`Pyodide`/`Wasmtime` WASM · `RemoteSandboxKernel` microVM) under one `Kernel` API — same `CapabilityManifest` (network/fs/env/cpu/memory) across every tier. | shipped | [kernels/comparison](./docs/kernels/comparison.md) |
| 3 | **Cross-runtime + offline closure** | Same kernel API on Node / any edge runtime / browser / air-gapped laptop. `@agentkit-js/model-local` + WASM kernel = full agent loop, **zero outbound traffic**. | shipped | [model-local](./packages/model-local/README.md) · [getting-started](./docs/guides/getting-started.md) |
| 4 | **Memory layers** | `MemoryBlockSet` (Letta-style in-context blocks, prompt-cache safe) + observational memory + Checkpointer + 4 KV backends (CF KV / DO / Redis / Upstash). | shipped | [memory](./docs/guides/memory.md) · [observational-memory](./docs/guides/observational-memory.md) |
| 5 | **Durable workflow engine** | `LocalWorkflowEngine` + `CloudflareWorkflowEngine` against the same `WorkflowDefinition` — observable, terminable, resumable, with the same contract test on both. | shipped | [durable-runtime](./docs/guides/durable-runtime.md) |
| 6 | **Code-mode (compress N MCP tools into 1)** | Single `execute_code` tool that compresses N MCP tools into one. Token cost on tool registries that grow stays flat instead of linear. Drop-in for Cloudflare codemode `DynamicWorkerExecutor` / OpenAI Agents SDK / Mastra. | shipped | [code-mode](./docs/guides/code-mode.md) |
| 7 | **Devtools + GenAI semconv OTel** | Zero-deploy local Studio (run-overview UI). `OtelBridge` emits standard `gen_ai.*` attributes (Datadog / Honeycomb / Grafana GenAI compatible) alongside legacy names. | shipped | [devtools](./packages/devtools/README.md) · [otel-exporter](./packages/otel-exporter/README.md) |
| 8 | **Goal-directed loop** | Agent synthesises its own success criteria, executes, verifies (deterministic + adversarial-defaulted LLM judge), retries with hints. The user states a goal; the framework supplies the loop. | **shipped 2026-06-18** | [goal-directed](./docs/guides/goal-directed.md) · [baseline](./docs/eval-reports/goal-directed-2026-06-18-baseline.md) · [strategy](./docs/strategy/2026-06-18-goal-directed-shipped.md) |
| 9 | **Adaptive execution** | When a tool fails, framework offers registered alternatives (L1). When none fits, agent synthesises a one-off via `execute_code` (L2). When the goal itself looks unreachable, agent proposes a relaxed criteria set the caller can accept/reject (L3). Repeat-hint stop-loss bounds blast radius. | **fully shipped + paired-stat verified 2026-06-18** | [strategy](./docs/strategy/2026-06-18-adaptive-execution.md) · [RFC](./docs/rfcs/adaptive-execution.md) · [ablation](./docs/eval-reports/adaptive-execution-2026-06-18-baseline.md) |

The eight (soon nine) axes compose. A goal-directed run can use a
local model (axis 1+3) running in a WASM kernel (axis 2), with a
verifier that checks workspace state via the workflow engine (axis 5),
traced through OTel (axis 7), and persisted to memory (axis 4). The
eighth axis raises the ceiling on what the first seven can deliver.
The ninth, when it lands, will let that ceiling survive a tool failing
or a goal turning out infeasible.

---

## Comparison

There are several mature TypeScript agent frameworks. Here is an honest assessment of where agentkit-js fits.

> **Last verified: 2026-06-15.** Each ⚠️/❌ cell links to its source on the column header's project. The "sandbox" rows have been re-framed (D2, 2026-06-13) so that having *some* sandbox is no longer the differentiator — three competitors now ship one. The remaining axes — **isolation tier composability**, **cross-runtime neutrality**, **offline closure** — are what no other framework offers in one package.

| | [Vercel AI SDK](https://github.com/vercel/ai) | [LangGraph.js](https://github.com/langchain-ai/langgraphjs) | [OpenAI Agents JS](https://github.com/openai/openai-agents-js) | [Mastra](https://github.com/mastra-ai/mastra) | [CF Agents SDK](https://github.com/cloudflare/agents) | **agentkit-js** |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **npm downloads/month** | ~57M | ~10M | ~3.8M | ~4M | ~3.2M | early-stage |
| **ToolCallingAgent** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Sandboxed code execution** | ❌ ([none in core](https://github.com/vercel/ai)) | ❌ ([none in core](https://github.com/langchain-ai/langgraphjs)) | ✅ [SandboxAgent](https://github.com/openai/openai-agents-js) — Unix-local / Docker / hosted | ✅ [Workspace](https://github.com/mastra-ai/mastra/tree/main/workspaces) — E2B / Daytona / Modal / Blaxel / Railway | ✅ [@cloudflare/sandbox](https://github.com/cloudflare/sandbox-sdk) container | ✅ kernels |
| **Isolation tiers — composable in one process** | n/a | n/a | ⚠️ 1 tier (process / container, picked at run time per client) | ⚠️ 1 tier per provider (you swap providers, not tiers) | ⚠️ 1 tier (container-per-DO, vendor-bound) | ✅ **3 tiers, swap with one line** — `VmKernel` (in-process) / WASM kernel (`QuickJS` / `Pyodide` / `Wasmtime`) / `RemoteSandboxKernel` (microVM); `factory.createKernel()` selects per call |
| **Cross-runtime neutrality** | ⚠️ Node + edge runtime patches | ✅ Node + edge | ⚠️ Node + Docker hosts (sandbox path needs a host process) | ⚠️ provider-specific (each provider has its own runtime constraint) | ❌ Cloudflare-only (sandbox is a CF Container) | ✅ **same kernel API on Node, any edge runtime, browser, and offline laptop** |
| **Offline / air-gapped closure** | ❌ requires provider HTTP | ❌ requires provider HTTP | ❌ Sandbox + model both need network | ❌ all sandbox providers are cloud SaaS | ❌ vendor-bound | ✅ `@agentkit-js/model-local` + WASM kernel = full agent loop with **zero outbound traffic** |
| **Python execution (edge-safe, no container)** | ❌ | ❌ | ❌ (containers required) | ❌ (containers required) | ❌ | ✅ Pyodide-in-WASM, runs inside a Worker isolate |
| **Anthropic prompt-cache management** | ⚠️ pass-through | ⚠️ pass-through | ⚠️ via adapter | ⚠️ pass-through | ❌ | ✅ auto breakpoints + 1h TTL |
| **Self-consistency / reflect-refine runners** | ❌ | ❌ manual | ❌ | ❌ | ❌ | ✅ built-in |
| **Budget forcing** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **DAG tool scheduler + speculative exec** | ❌ | ⚠️ graph-level | ❌ | ⚠️ workflow graph | ❌ | ✅ |
| **Long-history compaction** | ⚠️ syntactic prune | ❌ manual | ❌ | ⚠️ observational memory | ❌ | ✅ model-summarised |
| **MCP support** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Cloudflare Workers** | ⚠️ partial | ✅ | ⚠️ experimental | ⚠️ alpha | ✅ native | ✅ |
| **UI hooks (React/Next.js)** | ✅ best-in-class | ❌ | ❌ | ⚠️ via AI SDK | ⚠️ | ✅ useAgentRun |
| **Provider integrations** | 40+ | 300+ | OpenAI-primary | 40+ | CF Workers AI | Anthropic · OpenAI · Doubao · DeepSeek · Kimi · Qwen · GLM · MiniMax |
| **Evals framework** | ❌ | ⚠️ LangSmith | ❌ | ✅ 12+ scorers | ❌ | ✅ **16 scorers** + 2 multi-criterion judges |
| **Observability (OTel)** | ⚠️ LangSmith | ⚠️ LangSmith | ❌ | ✅ | ❌ | ✅ OtelBridge + GenAI semconv |
| **Retry / resilience** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ RetryPolicy |
| **Durable workflows / checkpointing** | ✅ DurableAgent (AI SDK 6) | ✅ LangGraph | ❌ (Assistants API retiring 2026-08-26) | ⚠️ partial | ✅ Durable Objects | ✅ Checkpointer + 4 backends (CF KV / DO / Redis / Upstash) |
| **SSE Last-Event-ID resume** | ⚠️ via DurableAgent | ✅ runtime | ❌ | ❌ | ❌ | ✅ EventLog primitive + worker-native |
| **HITL persisted suspend/resume** | ✅ | ✅ | ❌ | ⚠️ partial | ⚠️ via DO | ✅ stateless `/resume` endpoint, hours-to-days durations |
| **Embedded local LLM (in-process, offline)** | ⚠️ via Ollama HTTP | ⚠️ via Ollama HTTP | ❌ | ⚠️ via Ollama HTTP | ❌ | ✅ `@agentkit-js/model-local` — node-llama-cpp + grammar-constrained tool calls + multi-mirror downloads (HF / hf-mirror / ModelScope) |

### Where competitors are stronger

- **Vercel AI SDK** — If you're building a chat UI with Next.js, use this. The React hooks (`useChat`, `useAgent`), `DurableAgent` for stateful/resumable workflows (AI SDK 6), native MCP support, and DevTools panel are all best-in-class. 57M monthly downloads.
- **LangChain/LangGraph.js** — If you need 300+ integrations (vector stores, document loaders, obscure providers) or graph-based durable workflows with checkpointing and human-in-the-loop, LangGraph is battle-tested at LinkedIn, Uber, and GitLab scale.
- **Mastra** — Best eval framework (12+ built-in scorers including trajectory and tool accuracy). Strong developer onboarding. Their "Observational memory" pattern was first-mover; agentkit-js now ships an equivalent (`ObservationalMemory`) plus extra prompt-cache-aware compression — see [docs/guides/observational-memory.md](docs/guides/observational-memory.md).
- **Cloudflare Agents SDK** — If you're building on Cloudflare specifically, Durable Objects give you stateful agents with persistent scheduling that nothing else matches natively.
- **OpenAI Agents JS** — If your stack is OpenAI-only and you want first-party support, the cleanest path. The 2026-04 release added [`SandboxAgent`](https://github.com/openai/openai-agents-js) with Unix-local, Docker, and hosted clients; for OS-level isolation backed by OpenAI itself, this is the path of least resistance.

### Where agentkit-js is differentiated

- **Three isolation tiers under one swappable interface (D2, 2026-06-13).** OpenAI Agents JS now ships `SandboxAgent` (Unix-local / Docker / hosted) and Mastra ships Workspace providers (E2B / Daytona / Modal / Blaxel / Railway). The differentiator is no longer "has a sandbox" — it's that **agentkit-js exposes three tiers (`VmKernel` in-process, `QuickJSKernel` / `PyodideKernel` / `WasmtimeKernel` true WASM, `RemoteSandboxKernel` microVM) under one `Kernel` interface**, swap them with one line at call time, and apply one `CapabilityManifest` (network/fs/env/cpu/memory) across every tier. Competitors give you one tier wired to one provider. See [docs/kernels/comparison.md](docs/kernels/comparison.md) for the decision tree.
- **Cross-runtime neutrality.** Cloudflare's sandbox is fast on Cloudflare. Mastra's providers are SaaS. agentkit-js kernels run on Node, on any edge runtime, in a browser tab, and on a laptop with the network unplugged — same `Kernel` API, same security manifest. This is the structural advantage no platform-bound competitor can match.
- **Offline / air-gapped closure.** `@agentkit-js/model-local` (node-llama-cpp + grammar-constrained tool calls + multi-mirror downloads HF / hf-mirror / ModelScope) plus a WASM kernel = full agent loop with zero outbound traffic. For compliance-bound and air-gapped deployments, no other framework gives you this without writing the integration yourself.
- **Durable runtime** — Same `KvBackend` powers checkpoints, the SSE event log, and structured memory. Four production backends ship out of the box (Cloudflare KV / Durable Objects / Redis / Upstash REST). A paused `await_human_input` survives worker recycle for hours/days; `POST /resume` is stateless. See [docs/guides/durable-runtime.md](docs/guides/durable-runtime.md).
- **Quality runners** — Self-consistency with answer extraction (boxed / last-line / custom), reflect-refine, budget forcing ("Wait" prefill), and parallel fork-join are not shipped as first-class APIs by any competitor.
- **Anthropic prompt-cache optimization** — Framework actively manages `cache_control` breakpoint placement across multi-turn history, supports the 1-hour extended TTL (`ttl:"1h"`), and reports per-TTL cache usage. Competitors pass through or validate limits but do not optimise placement.
- **Speculative tool execution** — Read-only, idempotent tools are pre-executed ahead of write barriers within a DAG step. The scheduler is awakened by `$<callId>` dependency references in the system prompt, enabling true parallel + ordered hybrid scheduling. No competitor implements this.
- **GenAI semantic conventions** — `OtelBridge` emits standard `gen_ai.*` attributes (Datadog / Honeycomb / Grafana GenAI view compatible) alongside legacy names, switchable via `semconvMode`.
- **Observational Memory + cache-stable prefix (A1)** — Background "observer" model continuously compresses history into ranked observation paragraphs. The compressed prefix is byte-stable so Anthropic prompt cache hits stay hot across observations — Mastra's reference work has no equivalent. ~22% of baseline tokens on a 50-turn synthetic trace; see [`examples/benchmarks/observational-memory.mjs`](examples/benchmarks/observational-memory.mjs).
- **Time-travel debugger (A2)** — `@agentkit-js/devtools` exposes the existing `EventLog` + `Checkpointer` data through a navigable step timeline + "fork from any step" UI. LangGraph Studio's headline feature, shipped as a tiny opt-in package (logic core ~250 LOC, React UI optional).
- **Skills + lifecycle hooks (A3)** — `SkillRegistry` for progressive instruction/tool disclosure (Claude Agent SDK / CrewAI v1.12 convention). `ToolPostHook` chain (redact, truncate, audit) sits beside the existing `ToolGuardrail` — pre/post symmetry without confusing block vs transform semantics.
- **Multi-criterion LLM judges (A4)** — `judgeScorer` extends `llmJudge` with weighted criterion-level scoring + configurable scale. Two built-in judges (`trajectoryQualityJudge`, `answerCompletenessJudge`) work with any cheap Model adapter so judges run on Haiku/Doubao while the agent stays on Sonnet/Opus.
- **Reproducible benchmarks** — Every percentage in this README (`−37%`, `72→90%`, `−85%`, `−84%`) is verified by an offline benchmark in [`examples/benchmarks/`](examples/benchmarks/). Run `pnpm bench` to reproduce. CI fails the PR if any number drifts outside its tolerance.

### Honest caveats

agentkit-js is early-stage. The differentiating features (code execution kernels, durable runtime, quality runners, speculative scheduling) are technically novel but also niche — most teams pick a framework based on ecosystem breadth and documentation volume, where the mature options above win. Choose agentkit-js when sandboxed code execution, durable agent runs, prompt-cache cost control, or output quality runners are first-order concerns.

### Verified status

| | Number | Verified by |
|---|---|---|
| Tests passing (all packages) | **1341** | `bun run test` (CI matrix on every push) — `@agentkit-js/core` 716 · `@agentkit-js/mcp-server` 47 (D1: +11 portal) · `@agentkit-js/devtools` 34 · `@agentkit-js/evals-runner` 31 · `@agentkit-js/aisdk` 17 (D3: +3 memory) · `@agentkit-js/claude-agent-sdk` 7 · `@agentkit-js/openai-agents` 6 · others 483 |
| README percentages reproducible | **8 / 8** | `bun run bench` — runs in CI; non-zero exit blocks the PR (incl. A1 ≤25% target + S1/A1 code-mode ≤50% target + D1 Portal ≤10% / ≤66.7%) |
| Cross-process kill-and-resume (A1 DoD ①) | ✓ Redis + ✓ Cloudflare KV + ✓ Durable Object | `redis.test.ts` + `kvAdapters.test.ts` |
| SSE Last-Event-ID gap-free replay (A2 DoD ①) | ✓ | `EventLog.test.ts` round-trip test |
| Stateless HITL resume (A3 DoD ①) | ✓ | `hitl.test.ts` — three simulated processes |
| Observational memory ≥4× compression (A1) | ✓ 22% of baseline | `examples/benchmarks/observational-memory.mjs` |
| Code-mode bootstrap O(1) vs direct-MCP O(N) (S1/A1) | ✓ 13.6% of direct at N=30 tools | `examples/benchmarks/code-mode-tokens.mjs` |
| MCP Portal: O(1) bootstrap across M upstreams (D1) | ✓ 3.1% of direct multi-MCP at M=5×N=30 | `examples/benchmarks/portal-tokens.mjs` + `packages/mcp-server/src/portal.test.ts` (11 tests) + `examples/mcp-portal/` end-to-end demo |
| Step-fork bundle (A2 DevTools) | ✓ 9 unit + 8 jsdom render tests | `packages/devtools/src/EventLogReplay.test.ts` + `react/DevTools.test.tsx` |
| Skill lazy-load + post-hook chain (A3) | ✓ | `packages/core/src/skills/Skill.test.ts` + `guardrails/index.test.ts` |
| Judge scorer weighted breakdown (A4) | ✓ | `packages/core/src/evals/JudgeScorer.test.ts` |
| Paired-statistics parity vs scipy (evals-runner) | ✓ 31 reference values to ±1e-7 | `packages/evals-runner/src/stats/index.test.ts` |
| Local Studio HTTP overview (A4 of 2026-06-12 plan) | ✓ | `agentkit devtools --events-file <ndjson>` |
| Framework-agnostic GenAI semconv ingest (D5) | ✓ 9 adapter tests | `agentkit devtools --otel-events-file <path>` — accepts NDJSON or OTLP/JSON from any producer (Vercel AI SDK, Mastra, OpenAI Agents JS, Anthropic SDK) |
| Multi-model evaluation across 17× size range | ✓ 5 models, 2026-06-12 | `docs/reports/longmemeval-5model-2026-06-12.md` |

---

## Features

- **Two agent modes** — `CodeAgent` (writes + executes code) and `ToolCallingAgent` (native tool_use)
- **Code execution — three isolation tiers** — `VmKernel` (node:vm, in-process dev/test), `QuickJSKernel` / `PyodideKernel` / `WasmtimeKernel` (true WASM, language-level isolation, edge-safe), `RemoteSandboxKernel` (E2B / Cloudflare Sandbox microVM, full process isolation). Mix tiers via `factory.createKernel()`.
- **Programmatic Tool Calling (PTC)** — `ProgrammaticOrchestrator` executes model-generated scripts inside any kernel; `callTool()` calls registered tools without surfacing intermediate results to the context (−37% tokens). Self-hosted alternative to Anthropic's managed PTC container.
- **Prompt-cache optimization** — `MessageAssembler` builds cache-stable prefixes; Anthropic `cache_control` breakpoints respect the 4-breakpoint limit, per-chunk token thresholds, and the 1-hour extended TTL (`ttl:"1h"`); per-TTL usage metering (5m vs 1h); OpenAI automatic prefix cache hit tracking
- **Tool deferred loading** — `deferLoading: true` on any tool (or `McpToolCollection.deferAll()`) excludes its schema from the system prefix and loads on-demand via Anthropic Tool Search (−85% tokens for large MCP server collections)
- **Tool Use Examples** — `inputExamples` on any tool maps to Anthropic's `input_examples` wire field (72%→90% parameter accuracy)
- **Context editing** — `assembler.editToolResults({ maxTokens, keepRecent })` truncates old tool outputs reversibly without breaking conversation structure (+29% task performance, −84% tokens on web search)
- **Cross-session Memory Tool** — `createMemoryTool({ backend })` gives agents persistent read/write/list/delete memory backed by any `KvBackend` (Cloudflare KV, Redis, in-memory Map)
- **Quality runners** — majority-vote self-consistency with answer extraction (boxed / last-line / custom hook), critique-refine cycles, "Wait" prefill budget forcing, parallel fork-join with synthesis
- **DAG scheduling** — independent tool calls execute concurrently via `Scheduler`; read-only tools speculatively pre-execute ahead of write barriers; `$<callId>` dependency syntax in system prompt enables true data-dependency ordering; wired into `ToolCallingAgent` by default
- **Long-history compaction** — `agent.assembler.compact(model, keepRecentSteps)` summarises old steps; inject a custom `MessageAssembler` via `assembler` option
- **Production resilience** — automatic exponential backoff + jitter retry for 429 / 5xx / network errors on all model adapters; configurable via `RetryPolicy`
- **Evals framework** — `runEval()` with 16 built-in scorers covering correctness (`exactMatch`, `toolCallAccuracy`, `trajectoryValidity`, `finalAnswerLength`, `guardrailCompliance`), faithfulness, relevance, recovery, efficiency, constraints, plus two multi-criterion `JudgeScorer` judges (`trajectoryQualityJudge`, `answerCompletenessJudge`)
- **Evaluation harness** (`@agentkit-js/evals-runner`) — `runEvaluation()` plus `agentkit evals run` CLI: multi-model × multi-suite × multi-seed Pareto reports over (accuracy, cost, p95 wall). Six reference suites cover the gaps single-task benchmarks miss (long-context recall, multi-turn memory, agent trajectory, latency-under-budget, cost-per-correct, tool-sequence). Built-in paired statistics (McNemar exact / Wilson CI / paired bootstrap / G1 gate) match scipy reference values to ±1e-7. All synthetic fixtures — no overlap with public training corpora.
- **Code-mode MCP server** (`@agentkit-js/mcp-server`) — `createCodeModeServer()` collapses N downstream tools into a `docs_search` + `execute_code` two-tool MCP surface. At 30 tools the bootstrap-token cost drops to 13.6% of direct MCP (codemode-lite reported 53%); pairs with any agentkit kernel for unified security policy.
- **MCP Portal — federate N upstream servers behind one neutral two-tool surface (D1, 2026-06-13)** — `createPortalServer()` wraps multiple `ToolRegistry` / MCP upstreams (filesystem + GitHub + memory + …) into one code-mode face. Bootstrap stays O(1) regardless of how many upstreams are federated; at **5 servers × 30 tools = 150 tools**, the Portal is **3.1% of direct multi-MCP** and **19.8% of code-mode-per-server** (`examples/benchmarks/portal-tokens.mjs`). One `CapabilityManifest` spans every upstream — the audit boundary platform-bound Portals (Cloudflare's announced version) cannot give you across heterogeneous providers. See [`examples/mcp-portal/`](examples/mcp-portal/).
- **AI SDK + Mastra + Claude Agent SDK + OpenAI Agents JS plugin packages** (`@agentkit-js/aisdk`, `@agentkit-js/mastra-sandbox`, `@agentkit-js/claude-agent-sdk`, `@agentkit-js/openai-agents`) — drop agentkit's WASM kernels into Vercel AI SDK 4–6 (`sandboxedJsTool`, `codeModeTool`), Mastra (`agentkitMastraSandbox`), Anthropic Claude Agent SDK (`sandboxedJsClaudeTool`, `codeModeClaudeTool`), or OpenAI Agents JS (`sandboxedJsAgentTool`, `codeModeAgentTool`) without an external sandbox provider.
- **Observability** — `OtelBridge` maps `AgentEvent` streams to OTel-compatible spans; emits `gen_ai.*` semantic convention attributes (Datadog/Honeycomb/Grafana GenAI view compatible) with `semconvMode: "both" | "stable" | "legacy"`
- **Durable runtime** — `KvCheckpointer` with four production backends: `CloudflareKvBackend`, `DurableObjectKvBackend`, `RedisKvBackend` (ioredis-style), `RedisRestKvBackend` (Upstash REST, edge-safe). `CheckpointableRun` saves state after every step; `await_human_input` persists `pendingHumanInput` and exits the iterator so the worker can recycle while a human reviews.
- **SSE Last-Event-ID resume** — `EventLog` tags every event with a monotonic id, persists to the same `KvBackend`, and replays only the missing tail when a client reconnects. The reference Cloudflare Worker honors `Last-Event-ID` natively; `useAgentRun({ resume: { maxAttempts } })` retries automatically.
- **Stateless human-in-the-loop** — `resumeFromHuman(checkpointer, traceId, promptId, response)` writes the human's reply into a paused snapshot. Because there is no in-memory state, the worker that pauses and the worker that resumes can be different processes (and different days). See `examples/durable-runtime/`.
- **React hooks** — `@agentkit-js/react` provides `useAgentRun()` for streaming SSE agent events in Next.js / React apps
- **Multi-model** — Anthropic (Claude) and OpenAI-compatible endpoints (Ollama, vLLM, llama.cpp)
- **MCP support** — `McpToolCollection` wraps any MCP server's tools as first-class agentkit tools
- **Cloudflare Workers** — HTTP API entry point with KV session caching, ready to deploy with Wrangler

---

## Quick Start

### Code Agent

```ts
import { CodeAgent, AnthropicModel, AnthropicModels } from "@agentkit-js/core";

const agent = new CodeAgent({
  tools: [],
  model: new AnthropicModel(AnthropicModels.SONNET_LATEST),
  maxSteps: 10,
});

for await (const event of agent.run("What is 42 * 1337?")) {
  if (event.event === "final_answer") console.log(event.data.answer);
}
```

### Tool-Calling Agent

```ts
import { ToolCallingAgent, AnthropicModel, AnthropicModels } from "@agentkit-js/core";
import { z } from "zod";

const searchTool = {
  name: "search",
  description: "Search the web",
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.string(),
  readOnly: true,
  idempotent: true,
  forward: async ({ query }) => `Results for: ${query}`,
};

const agent = new ToolCallingAgent({
  tools: [searchTool],
  model: new AnthropicModel(AnthropicModels.SONNET_LATEST),
  maxSteps: 5,
});

for await (const event of agent.run("Search for recent AI news")) {
  if (event.event === "final_answer") console.log(event.data.answer);
}
```

### CLI

```bash
# Install globally
npm install -g @agentkit-js/cli

# Run a task
agentkit run "What is the square root of 144?"

# Stream all events as NDJSON
agentkit run "Summarise recent AI news" --stream | jq .

# Use a specific model
agentkit run "Write a haiku" --model claude-opus-4-8 --max-steps 5
```

---

## Quality Runners

### Self-Consistency — majority vote across N independent runs

```ts
import { SelfConsistencyRunner, AnthropicModel, AnthropicModels } from "@agentkit-js/core";

const runner = new SelfConsistencyRunner({
  model: new AnthropicModel(AnthropicModels.SONNET_LATEST),
  tools: [],
  n: 5,
  concurrency: 3,
  earlyStop: true,
});

const answer = await runner.run("What is the capital of France?");
```

### Reflect-Refine — critique loop until quality signal passes

```ts
import { ReflectRefineRunner, AnthropicModel, AnthropicModels } from "@agentkit-js/core";

const runner = new ReflectRefineRunner({
  model: new AnthropicModel(AnthropicModels.SONNET_LATEST),
  tools: [],
  maxCycles: 3,
  qualitySignal: (answer) => answer.length > 100,
});

const answer = await runner.run("Write a detailed analysis of...");
```

### Parallel Fork-Join — diverse reasoning paths, synthesised answer

```ts
import { ParallelForkJoinRunner, AnthropicModel, AnthropicModels } from "@agentkit-js/core";

const runner = new ParallelForkJoinRunner({
  branches: 3,
  concurrency: 3,
  aggregation: "summary",
  branchPrompt: (i, msgs) => [
    ...msgs,
    { role: "user", content: `Analyse from perspective ${i + 1} of 3.` },
  ],
});

const result = await runner.run(
  new AnthropicModel(AnthropicModels.SONNET_LATEST),
  [{ role: "user", content: "What are the trade-offs of microservices?" }]
);
console.log(result.answer);   // synthesised
console.log(result.branches); // individual paths
```

### Long-history compaction

```ts
import { CodeAgent, AnthropicModel, AnthropicModels, MessageAssembler } from "@agentkit-js/core";

const model = new AnthropicModel(AnthropicModels.SONNET_LATEST);
const assembler = new MessageAssembler({ chunkSizeSteps: 8 });
const agent = new CodeAgent({
  tools: [],
  model,
  maxSteps: 50,
  assembler,
});

// Summarise old steps, keep context window in check
await agent.assembler.compact(model, 5);
```

---

## Custom Endpoints & Local Models

Both adapters accept an optional `baseURL` to point at any compatible endpoint — local models, third-party proxies, or private deployments.

### OpenAI-compatible (Ollama / vLLM / llama.cpp / any proxy)

```ts
import { OpenAIModel, OpenAIModels } from "@agentkit-js/core";

// Hosted OpenAI
const gpt4o = new OpenAIModel(OpenAIModels.GPT_4O);

// Local Ollama
const local = new OpenAIModel("mistral-7b", {
  baseURL: "http://localhost:11434/v1",
  apiKey: "ollama",
  samplingParams: { temperature: 0.7, seed: 42 },
});
```

### Anthropic-compatible proxy or private deployment

```ts
import { AnthropicModel, AnthropicModels } from "@agentkit-js/core";

// Standard usage — reads ANTHROPIC_API_KEY from environment
const model = new AnthropicModel(AnthropicModels.SONNET_LATEST);

// Third-party proxy or private endpoint
const proxied = new AnthropicModel(AnthropicModels.SONNET_LATEST, {
  apiKey: "your-proxy-key",
  baseURL: "https://your-proxy.example.com",
});
```

### Chinese model providers (first-class adapters)

Seven providers ship as dedicated packages with full thinking-mode, reasoning-field, and cache-strategy support:

```ts
// Doubao / Volcengine Ark (first-class thinking + effort tiers)
import { DoubaoModel, DoubaoModels } from "@agentkit-js/model-doubao";
const doubao = new DoubaoModel(DoubaoModels.LATEST, process.env.ARK_API_KEY);
for await (const e of doubao.generate(msgs, { thinking: { mode: "enabled", effort: "high" } })) { ... }

// DeepSeek V4 (thinking:{type} + effort, V4_FLASH available)
import { DeepSeekModel, DeepSeekModels } from "@agentkit-js/model-deepseek";
const ds = new DeepSeekModel(DeepSeekModels.V4_PRO, process.env.DEEPSEEK_API_KEY);

// Kimi K2.6 (reasoning field: delta.reasoning, thinking:{type} via extra_body)
import { MoonshotModel, KimiModels } from "@agentkit-js/model-moonshot";
const kimi = new MoonshotModel(KimiModels.LATEST, process.env.MOONSHOT_API_KEY);

// Qwen3 (enable_thinking + thinking_budget, intl region option)
import { QwenModel, QwenModels } from "@agentkit-js/model-qwen";
const qwen = new QwenModel(QwenModels.QWEN3_MAX, { region: "cn" });

// GLM-5 (Zhipu self-hosted, thinking:{type} via extra_body)
import { ZhipuModel, GLMModels } from "@agentkit-js/model-zhipu";
const glm = new ZhipuModel(GLMModels.GLM_5, process.env.ZHIPU_API_KEY);

// MiniMax M3 (reasoning_split=true → reasoning_details; or <think> tag parsing)
import { MiniMaxModel, MiniMaxModels } from "@agentkit-js/model-minimax";
const mm = new MiniMaxModel(MiniMaxModels.M3, process.env.MINIMAX_API_KEY);
```

**Provider capability reference:**

| Provider | Package | Thinking switch | Reasoning field | Cache strategy | Multi-turn round-trip |
|---|---|---|---|---|---|
| **Doubao/Ark** | `model-doubao` | `extra_body.thinking.{type,level}` | `delta.reasoning_content` | `auto-prefix` (transparent) / `ark-context` (explicit) | tool-turns-only |
| **DeepSeek V4** | `model-deepseek` | `extra_body.thinking.{type,effort}` | `delta.reasoning_content` | `auto-prefix` | tool-turns-only |
| **Kimi K2.6** | `model-moonshot` | `extra_body.thinking.{type}` | `delta.reasoning` (K2.6) / `delta.reasoning_content` (K2) | `auto-prefix` | tool-turns-only |
| **Qwen3** | `model-qwen` | `enable_thinking` + `thinking_budget` | `delta.reasoning_content` | `auto-prefix` | never |
| **GLM-5** | `model-zhipu` | `extra_body.thinking.{type}` | `delta.reasoning_content` | `auto-prefix` | never |
| **MiniMax M3** | `model-minimax` | `reasoning_split:true` | `delta.reasoning_details` (or `<think>` in content) | `auto-prefix` | never |

> **Note on multi-turn round-trip**: DeepSeek/Doubao/Kimi require `reasoning_content` echoed back in assistant messages containing `tool_use` (not in text-only turns — that causes a 400 error). The adapters implement this automatically via `reasoningRoundTripPolicy: "tool-turns-only"`.

---

## Deploy to Cloudflare Workers

```bash
cd packages/cloudflare-worker
cp wrangler.toml.example wrangler.toml   # edit account_id and kv_namespaces
wrangler secret put ANTHROPIC_API_KEY
wrangler deploy
```

The Worker exposes a POST `/run` endpoint. Session state is stored in KV for cost-efficient prompt caching across requests.

---

## Packages

agentkit-js is a 33-package monorepo. See **[`docs/packages.md`](docs/packages.md)** for the canonical, tier-classified list (★ Core / ◆ Narrative / ▽ Maintenance), with one-line descriptions of each package and links to its README.

For the maintenance-tier rationale, see [`docs/strategy/maintenance-tiers.md`](docs/strategy/maintenance-tiers.md).

---

## Production APIs

### Retry / Resilience (C1)

All model adapters automatically retry 429 / 5xx / network errors with exponential backoff + jitter:

```ts
import { AnthropicModel } from "@agentkit-js/core";

const model = new AnthropicModel("claude-sonnet-4-6", {
  apiKey: process.env.ANTHROPIC_API_KEY,
  retry: { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 30_000 },
});
```

### Evals (B1)

```ts
import { runEval, exactMatch, toolCallAccuracy } from "@agentkit-js/core";

const results = await runEval(dataset, async function* (task) {
  yield* agent.run(task);
}, [exactMatch, toolCallAccuracy]);
```

### OpenTelemetry Bridge (C2)

```ts
import { OtelBridge, InMemorySpanExporter, withOtel } from "@agentkit-js/core";

const exporter = new InMemorySpanExporter(); // swap for OTLP in production
const bridge = new OtelBridge({ exporter });
for await (const ev of withOtel(agent.run(task), bridge)) {
  console.log(ev);
}
bridge.flush();
```

### Durable runtime — Checkpoints, SSE resume, HITL

Pick **one** `KvBackend` and use it for checkpoints, the SSE event log, and structured memory — there is one canonical contract.

```ts
import {
  CheckpointableRun,
  EventLog,
  KvCheckpointer,
  resumeFromHuman,
  applyHumanResponse,
  restoreFromSnapshot,
} from "@agentkit-js/core";
// Pick a backend that matches your runtime.
import { CloudflareKvBackend } from "@agentkit-js/cloudflare-worker";
// Other options: DurableObjectKvBackend (CF), RedisKvBackend (Node/Bun),
// RedisRestKvBackend (Upstash, edge-safe), MapKvBackend (tests).

const kv = new CloudflareKvBackend(env.MY_KV);
const checkpointer = new KvCheckpointer(kv);
const log = new EventLog(kv); // SSE Last-Event-ID resume
const wrapper = new CheckpointableRun({ checkpointer }, agent.assembler);

// Stream + persist + tag every event with a monotonic id.
for await (const { eventId, event } of log.tap(
  wrapper.run(agent.run(task), task, traceId),
  traceId,
)) {
  // emit `id: ${eventId}\nevent: ${event.event}\ndata: ${...}\n\n` over SSE
  if (event.event === "await_human_input") {
    // Snapshot is already persisted; the worker is free to exit.
    return;
  }
}
```

**Resume after a worker recycle** (different process, possibly different machine):

```ts
const lastId = req.headers.get("Last-Event-ID");
for await (const { eventId, event } of log.replay(traceId, lastId)) { /* re-emit */ }
const startSeq = await log.nextSeq(traceId);
for await (const { eventId, event } of log.tap(agent.run(task, traceId), traceId, { startSeq })) { /* live tail */ }
```

**Resume after human approval** (could be hours/days later):

```ts
// In the /resume HTTP handler — stateless, returns immediately.
await resumeFromHuman(checkpointer, traceId, promptId, response);

// Later, when a worker picks up the trace:
const snap = await checkpointer.load(traceId);
restoreFromSnapshot(snap, agent.assembler);
applyHumanResponse(snap, agent.assembler); // injects user_message into history
// Then continue with `wrapper.run(agent.run(snap.task, traceId), ...)`.
```

The reference Cloudflare Worker (`@agentkit-js/cloudflare-worker`) wires all of this for you — bind `AGENTKIT_EVENT_LOG` and `AGENTKIT_CHECKPOINTS` in `wrangler.toml` and you get `Last-Event-ID` resume + a `POST /resume` endpoint out of the box. Full guide: [docs/guides/durable-runtime.md](docs/guides/durable-runtime.md).

### React Hook (B2)

```tsx
import { useAgentRun } from "@agentkit-js/react";

function ChatUI() {
  const { messages, isRunning, run } = useAgentRun("/api/run");
  return (
    <>
      {messages.map((m) => <div key={m.id}>{m.content}</div>)}
      <button onClick={() => run({ task: "What is 2 + 2?" })} disabled={isRunning}>
        Ask
      </button>
    </>
  );
}
```

### Tool Deferred Loading (L1-1)

Exclude large MCP server tool schemas from the context prefix; load on-demand via Anthropic Tool Search. Reduces token usage by up to 85% on servers with many tools.

```ts
import { McpToolCollection, ToolCallingAgent, AnthropicModel, AnthropicModels } from "@agentkit-js/core";

// Option A: defer all tools from an MCP server with many tools.
const tools = await McpToolCollection.fromHttp("https://big-mcp-server.example.com");
tools.deferAll(); // marks all tools as deferLoading: true

// Option B: defer individual tools via the ToolDefinition field.
const myTool = {
  name: "my_tool",
  deferLoading: true,   // excluded from system prefix
  // ... other fields
};

const agent = new ToolCallingAgent({
  tools: tools.list(),
  model: new AnthropicModel(AnthropicModels.SONNET_LATEST),
});
```

### Tool Use Examples (L1-2)

Provide few-shot examples to improve parameter accuracy from ~72% to ~90%.

```ts
const searchTool = {
  name: "search",
  description: "Search the web for information",
  inputSchema: z.object({ query: z.string(), maxResults: z.number().optional() }),
  inputExamples: [
    { query: "latest AI research 2026", maxResults: 5 },
    { query: "TypeScript best practices" },
  ],
  // ...
};
```

### Context Editing (L2-1)

Truncate old tool outputs reversibly to reduce context size without breaking conversation structure.

```ts
import { MessageAssembler, AnthropicModel, AnthropicModels } from "@agentkit-js/core";

const model = new AnthropicModel(AnthropicModels.SONNET_LATEST);
const assembler = new MessageAssembler({ chunkSizeSteps: 8 });
const agent = new ToolCallingAgent({ tools, model, assembler, maxSteps: 50 });

// After many steps, truncate old tool outputs that are taking too many tokens.
// Keeps the 3 most recent tool steps verbatim; truncates older ones.
const truncated = agent.assembler.editToolResults({ maxTokens: 4096, keepRecent: 3 });
console.log(`Truncated ${truncated} tool outputs`);
```

### Cross-Session Memory Tool (L2-2)

Give agents persistent memory that survives across separate `run()` calls.

```ts
import { createMemoryTool, MapKvBackend, ToolCallingAgent, AnthropicModel, AnthropicModels } from "@agentkit-js/core";

// Use MapKvBackend for in-process use, or KvCheckpointer's backend for persistence.
const memory = createMemoryTool({ backend: new MapKvBackend() });

const agent = new ToolCallingAgent({
  tools: [memory, ...otherTools],
  model: new AnthropicModel(AnthropicModels.SONNET_LATEST),
});

// Session 1: agent learns something
for await (const ev of agent.run("What's the capital of France? Remember it for later.")) { }

// Session 2: agent recalls it
for await (const ev of agent.run("What did you remember about France's capital?")) {
  if (ev.event === "final_answer") console.log(ev.data.answer); // "Paris"
}
```

### Programmatic Tool Calling / Self-Hosted PTC (L3-1)

Execute model-generated orchestration scripts inside a kernel; only the final result enters the context window.

```ts
import { ProgrammaticOrchestrator, JsKernel, ToolRegistry } from "@agentkit-js/core";

const kernel = new JsKernel();
const registry = new ToolRegistry();
registry.register(searchTool);
registry.register(calcTool);

const orchestrator = new ProgrammaticOrchestrator(kernel, registry, {
  extraCapabilities: ["tool:search", "tool:calc"],
});

// Model-generated script — intermediate results never enter the LLM context.
const script = `
  const results = callTool('search', { query: 'AI news 2026' });
  const count = callTool('calc', { expr: results.length + ' items' });
  count + ' found';
`;
const { finalOutput, toolCallCount } = await orchestrator.run(script);
console.log(finalOutput);    // Only this enters the context window.
console.log(toolCallCount);  // e.g. 2 — intermediate results stayed in the kernel.
```

---

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck

# Reproduce every percentage in the "Differentiated" section above.
pnpm bench

# Cloudflare Worker local dev
cd packages/cloudflare-worker && wrangler dev
```

### Examples

| Example | What it shows |
|---|---|
| `examples/basic-agent/` | Minimal `CodeAgent` end-to-end |
| `examples/tool-calling-agent/` | `ToolCallingAgent` with tools |
| `examples/tool-search-rag/` | RAG-style retrieval tool |
| `examples/durable-runtime/` | Checkpoint + SSE resume + HITL across three simulated processes (no model needed) |
| `examples/eval-suite/` | Composite scorer over a small dataset |
| `examples/benchmarks/` | Reproducible verification of every README percentage |
| `examples/cf-production/` | Production-style Worker deployment |
| `examples/otel-jaeger/` | OTel bridge with Jaeger backend |
| `examples/observational-memory/` (in benchmarks) | **A1** — measure compression ratio of `ObservationalMemory` vs baseline |
| `examples/devtools-replay/` | **A2** — synthetic event trace + `EventLogReplay` fork-from-step demo (offline) |
| `examples/skills-demo/` | **A3** — three lazily-loaded skills + post-hook chain (redact + truncate) |
| `examples/judge-scorer-demo/` | **A4** — code-based vs LLM-judge scorer divergence on a synthetic trace |

### Documentation

- [docs/guides/durable-runtime.md](docs/guides/durable-runtime.md) — checkpoints, SSE Last-Event-ID resume, HITL
- [docs/kernels/comparison.md](docs/kernels/comparison.md) — kernel selection decision tree
- [docs/guides/evals-cookbook.md](docs/guides/evals-cookbook.md) — eval design patterns (incl. A4 multi-criterion judges)
- [docs/guides/memory-patterns.md](docs/guides/memory-patterns.md) — memory namespace + decay patterns
- [docs/guides/observational-memory.md](docs/guides/observational-memory.md) — **A1** background-observer compression
- [docs/guides/devtools.md](docs/guides/devtools.md) — **A2** time-travel debugger + fork-from-step
- [docs/guides/skills-and-hooks.md](docs/guides/skills-and-hooks.md) — **A3** progressive disclosure + post-tool hooks

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic model access |
| `OPENAI_API_KEY` | OpenAI / compatible endpoint |
| `CLOUDFLARE_API_TOKEN` | CI/CD Worker deployment |
| `CLOUDFLARE_ACCOUNT_ID` | CI/CD Worker deployment |

---

## Acknowledgements

Inspired by Hugging Face's [smolagents](https://github.com/huggingface/smolagents). agentkit-js is a ground-up TypeScript reimplementation — not a port — targeting async-first execution, WASM sandboxing, and edge deployment.

## License

Apache 2.0
