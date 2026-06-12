# 基准数字

> 本页每一个数字都在每次 push 时由 CI 复现。漂移超出 ±10 % 直接让构建失败 — 见 [`.github/workflows/ci.yml`](https://github.com/telleroutlook/agentkit-js/blob/main/.github/workflows/ci.yml)。

自己跑一遍：

```bash
git clone https://github.com/telleroutlook/agentkit-js
cd agentkit-js
bun install
bun run bench           # 全部基准
bun run bench -- ptc    # 单跑某一项
```

## 可复现的节省

| 能力 | 实测 | 目标 | 脚本 |
|---|---|---|---|
| **Programmatic Tool Calling** vs 每次工具调用都走完整 round-trip | **5.1 %** of baseline tokens（–94.9 %） | ≤63 %（≥–37 %） | [`ptc-tokens.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/ptc-tokens.mjs) |
| **工具延迟加载**（懒发现 MCP 工具） | **10.0 %** of baseline tokens（–90 %） | ≤15 %（≥–85 %） | [`defer-loading.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/defer-loading.mjs) |
| **`inputExamples` 准确度提升** | 76 % → **92 %** | 72 → 90 | [`input-examples.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/input-examples.mjs) |
| **上下文编辑**（缓存稳定的历史压缩） | **13.8 %** of baseline tokens（–86 %） | ≤16 %（≥–84 %） | [`context-editing.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/context-editing.mjs) |
| **观察记忆**（压缩反思前缀） | **21.9 %** of baseline（–78 %） | ~22 %（≤25 %） | [`observational-memory.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/observational-memory.mjs) |
| **`ParallelForkJoinRunner`**（8 分支，cap=4） | wall-clock 比等效串行**快 ~3.8×**；token 线性增长 | ≥2.5× 加速，4–12× token | [`parallel-agents.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/parallel-agents.mjs) |
| **跨模型成本对比**（同任务，11 个模型） | DeepSeek V4 最便宜 **~$0.003**；Claude Opus 最贵 **~$0.15**（≈56× 比） | 最便宜 <$0.05、最贵 <$5、比值 5–200× | [`cost-comparison.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/cost-comparison.mjs) → [报告](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/report-cost-comparison.md) |

## 为什么这些不是营销数字

- **聚焦机制，不依赖 API key**。每个基准用一个确定性的 fake model 返回脚本化轨迹。我们测量的是 *机制是否真的剔除了 schema / 压缩了历史 / 缓存了前缀*，不是反复问 LLM 同一个问题。
- **CI 守护**。任何漂移到容差之外的回归都会让构建失败 — README 不可能悄无声息地腐坏。
- **可复现**。无隐藏 flag、无特殊环境 — `bun run bench` 就是完整流水线。

同样的方法论扩展到后续的数字：并行 runner wall-clock（Wave 4）、跨模型成本对比（Wave 5 / H）、kernel 冷启动。

## 阅读源码

runner 是单文件 — [`examples/benchmarks/run-all.mjs`](https://github.com/telleroutlook/agentkit-js/blob/main/examples/benchmarks/run-all.mjs) — 它 import 每一项基准、调用、容差越界则非零退出。
