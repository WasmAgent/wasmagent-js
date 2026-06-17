# Compare

A short cut of the [comparison table from the main README](https://github.com/telleroutlook/agentkit-js#readme).

> **2026-06-17 update.** The framework field has shifted: OpenAI Agents
> SDK now has a *native sandbox* (2026-04), Vercel AI SDK 6 ships
> `DurableAgent` + a DevTools panel, Cloudflare ships code-mode
> portal-default. Several rows that used to be **agentkit-only** are
> now **table stakes**. The differentiation has tightened to
> *swappability* (drop our kernel into any framework's executor
> socket) and *governance* (`CapabilityManifest` ↔ OWASP Agentic
> Top 10 with real WASM isolation; see
> [`docs/security/capability-manifest-owasp.md`](https://github.com/telleroutlook/agentkit-js/blob/main/docs/security/capability-manifest-owasp.md)).

|  | Vercel AI SDK 6 | Mastra | LangGraph.js | OpenAI Agents JS | CF Agents SDK | **agentkit-js** |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Edge-safe sandboxed code execution | ❌ | ❌ | ❌ | ✅ native sandbox (2026-04) | ✅ isolate (CF only) | ✅ **3 tiers, portable** |
| Real Python in-process | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ Pyodide |
| Auto prompt-cache breakpoints + 1h TTL | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Code-mode MCP server (docs_search + execute_code) | ❌ | ❌ | ❌ | ⚠️ via Agents SDK builtin | ✅ portal-default (2026-03) | ✅ |
| Chinese models (Doubao / DeepSeek / Kimi / Qwen / GLM / MiniMax) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Time-travel debugger + fork-from-step | ❌ | ✅ Studio | ✅ Studio | ❌ | ❌ | ✅ |
| Stateless HITL + SSE Last-Event-ID resume | ✅ `DurableAgent` (2026-Q1) | ⚠️ partial | ✅ | ❌ | ⚠️ DO only | ✅ |
| Local Studio (cost / latency / errors) | ✅ DevTools panel | ✅ Studio (SaaS) | ❌ | ❌ | ❌ | ✅ zero-deploy, no telemetry |
| Pareto-first multi-model evaluation harness | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Reproducible benchmarks gated by CI | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Framework-neutral `CapabilityManifest` + WASM isolation (OWASP-mapped)** | ❌ | ❌ | ❌ | ⚠️ sandbox without policy primitive | ⚠️ isolate without portable policy | ✅ |
| **Drop-in executor for other frameworks' sandbox sockets** | (target: AI SDK provider) | ✅ `mastra-sandbox` | n/a | (target: Agents SDK provider) | (target: codemode `DynamicWorkerExecutor`) | ✅ |

> "❌" means the framework does not ship the capability today (2026-06).
> Where alternatives are partially available, "⚠️" notes the caveat.
> We re-verify quarterly. The two new rows at the bottom were added
> 2026-06-17 to reflect the tightened differentiation.

## Where we are not

We are intentionally **not** competing on:

- Number of integrations — LangChain has 300+; we won't catch up on raw breadth.
- React-first DX — Vercel AI SDK 6 ships as the default in Next.js templates; we don't try to dethrone that.
- Hosted commercial SaaS — Mastra Cloud, LangSmith, Vercel platform. We're a runtime + framework, not a hosted product.
- **Headline benchmark numbers.** Agent benchmarks are in a "self-reported, never independently reproduced" trust crisis (2026-Q1/Q2 industry consensus). Our angle is the *referee, not the contestant* — `evals-runner` (paired McNemar / Wilson / bootstrap, scipy-aligned 1e-7) is the harness anyone can re-run on any pair of agents. Worked example: [three-round arm-f vs bare vs batch-grammar ablation](https://github.com/telleroutlook/agentkit-js/tree/main/docs/reports/arm-f-vs-bare-2026-06-17).

If you're choosing between agentkit-js and one of the above frameworks, the question is whether you need any of the rows in the table that say "✅" only for agentkit-js. If you don't, the bigger ecosystems are the right call.

## Why three sandbox tiers?

See the [kernel decision tree](/kernels/comparison) — every cell other than agentkit-js is "❌" because no framework treats sandbox isolation as a swappable interface across runtimes (in-process / WASM / remote) and languages (JS + real Python).

## Compose, don't switch (this is the headline pitch — 2026-06-17)

If you already use Vercel AI SDK 6, Mastra, OpenAI Agents JS, Claude Agent SDK, or Cloudflare's codemode — **you do not need to switch frameworks to use agentkit's kernels**. Each kernel is an `import` away:

- [Use kernels with Vercel AI SDK](/guides/integrate-vercel-ai-sdk)
- [Use kernels with Mastra](/guides/integrate-mastra)
- [Use kernels with Claude Agent SDK](/guides/integrate-claude-agent-sdk)
- [Use kernels with OpenAI Agents JS](/guides/integrate-openai-agents)
- *Coming Q3:* drop `kernel-quickjs` / `kernel-pyodide` into Cloudflare codemode's `DynamicWorkerExecutor` socket — the architecture document is at [`docs/strategy/upstream-prs/cloudflare-codemode-byo-executor.md`](https://github.com/telleroutlook/agentkit-js/blob/main/docs/strategy/upstream-prs/cloudflare-codemode-byo-executor.md).

The single sentence: **swap the executor, keep your framework**.
