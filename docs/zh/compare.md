# 对比

[主 README 完整对比表](https://github.com/telleroutlook/agentkit-js#readme)的精简中文版。

|  | Vercel AI SDK | Mastra | LangGraph.js | OpenAI Agents JS | CF Agents SDK | **agentkit-js** |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| 边缘安全沙箱化代码执行 | ❌ | ❌ | ❌ | ⚠️ OS / Docker | ❌ | ✅ **3 层** |
| 进程内真 Python | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ Pyodide |
| 自动 prompt-cache 断点 + 1h TTL | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| 国产模型（豆包 / DeepSeek / Kimi / 千问 / GLM / MiniMax） | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| 时间旅行调试器 + 任意步分叉 | ❌ | ❌ | ✅ Studio | ❌ | ❌ | ✅ |
| Stateless HITL + SSE Last-Event-ID 续传 | ❌ | ⚠️ 部分 | ✅ | ❌ | ⚠️ 仅 DO | ✅ |
| CI 守护的可复现基准 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

> "❌" 表示该框架今天（2026 年 6 月）没有这项能力。"⚠️" 表示部分支持。每季度重新核实。

## 我们刻意不竞争的赛道

agentkit-js **不**与下面这些角度竞争：

- **集成数量** — LangChain 已有 300+ 集成；这条赛道的领先位置我们追不上。
- **React 优先 DX** — Vercel AI SDK 6 已是 Next.js 默认模板；不去夺这把椅子。
- **托管 SaaS** — Mastra Cloud、LangSmith、Vercel 平台。我们是运行时 + 框架，不是托管产品。

如果你在 agentkit-js 与上述框架之间做选择，问题是：**你是否需要表中只有 agentkit-js 才打 ✅ 的某一行？** 如果不需要，那些更大生态的框架就是正确选择。

## 为什么是三层沙箱？

参见 [kernel 决策树](/zh/kernels-comparison) — 表里其他每个框架在这一行打 "❌"，是因为没有任何一家把沙箱隔离当成"可热插拔的接口"对待。

## 想组合而不是替换？

agentkit-js 的任何 kernel 都可以从任何框架内独立使用，**没有对 agentkit-js 其余部分的依赖**。教程：

- [在 Vercel AI SDK 中使用 agentkit-js kernel](/zh/guides/integrate-vercel-ai-sdk)
- [在 Mastra 中使用 agentkit-js kernel](/zh/guides/integrate-mastra)
