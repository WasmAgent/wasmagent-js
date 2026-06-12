# Compare

A short cut of the [comparison table from the main README](https://github.com/telleroutlook/agentkit-js#readme).

|  | Vercel AI SDK | Mastra | LangGraph.js | OpenAI Agents JS | CF Agents SDK | **agentkit-js** |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Edge-safe sandboxed code execution | ❌ | ❌ | ❌ | ⚠️ OS / Docker | ❌ | ✅ **3 tiers** |
| Real Python in-process | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ Pyodide |
| Auto prompt-cache breakpoints + 1h TTL | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Code-mode MCP server (docs_search + execute_code) | ❌ | ❌ | ❌ | ❌ | ⚠️ proprietary | ✅ |
| Chinese models (Doubao / DeepSeek / Kimi / Qwen / GLM / MiniMax) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Time-travel debugger + fork-from-step | ❌ | ❌ | ✅ Studio | ❌ | ❌ | ✅ |
| Stateless HITL + SSE Last-Event-ID resume | ❌ | ⚠️ partial | ✅ | ❌ | ⚠️ DO only | ✅ |
| Local Studio (cost / latency / errors) | ❌ | ✅ Studio (SaaS) | ❌ | ❌ | ❌ | ✅ zero-deploy |
| Pareto-first multi-model evaluation harness | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Reproducible benchmarks gated by CI | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

> "❌" means the framework does not ship the capability today (June 2026). Where alternatives are partially available, "⚠️" notes the caveat. We re-verify quarterly.

## Where we are not

We are intentionally **not** competing on:

- Number of integrations — LangChain has 300+; we won't catch up on raw breadth.
- React-first DX — Vercel AI SDK 6 ships as the default in Next.js templates; we don't try to dethrone that.
- Hosted commercial SaaS — Mastra Cloud, LangSmith, Vercel platform. We're a runtime + framework, not a hosted product.

If you're choosing between agentkit-js and one of the above frameworks, the question is whether you need any of the rows in the table that say "✅" only for agentkit-js. If you don't, the bigger ecosystems are the right call.

## Why three sandbox tiers?

See the [kernel decision tree](/kernels/comparison) — every cell other than agentkit-js is "❌" because no framework treats sandbox isolation as a swappable interface.

## Want to compose, not switch?

You can use any agentkit-js kernel from any framework — they have no dependency on the rest of agentkit-js. Tutorials:

- [Use kernels with Vercel AI SDK](/guides/integrate-vercel-ai-sdk)
- [Use kernels with Mastra](/guides/integrate-mastra)
