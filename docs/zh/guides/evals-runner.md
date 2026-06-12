# 评测 runner — 把 agentkit-js 当成模型评测器用

> **状态**:`@agentkit-js/evals-runner@0.1.0` 已发布(2026-06-12)。
> 厂商无关 OpenAI 兼容:Ollama / OpenRouter / AI Gateway / OpenAI / vLLM
> 都行。模型规格格式跟 agentkit-js 其他地方一样
> ([`docs/zh/guides/openai-compat-recipes`](./openai-compat-recipes.md))。

## 它做什么

接收一组模型 + 一组评测套件 + 一组 seed,跑完整笛卡尔积,产出一个标了 Pareto 前沿的 markdown 报告。
[`docs/zh/benchmarks`](../benchmarks.md) 里 5 模型横向对比就是它的真实输出。

## CLI

```bash
# 看套件列表:
agentkit evals list

# 5 个本地 Ollama 模型 × multi-turn-memory 套件 × 3 seed:
agentkit evals run \
  --suite=multi-turn-memory \
  --models="qwen2.5:0.5b,evo-qwen3-1b7-q3km:latest,evomerge-qwen25-1b5:latest,evomerge-qwen3-v2:latest,gemma4-12b:latest" \
  --base-url=http://localhost:11434/v1 \
  --seeds=0,1,2 \
  --report-file=./eval.md
```

`--models` 接收逗号分隔的 `id@baseUrl#modelId`。`@baseUrl` 和 `#modelId` 都可省略 — `id` 没指定 `#modelId` 时直接当 wire-level 模型名;`--base-url` 给省略 `@` 的 spec 兜底。

## 6 个参考评测套件

| 套件 | 测什么 |
|---|---|
| `multi-turn-memory` | 6 题 LongMemEval-style 多会话回忆 |
| `long-context-recall` | 在 ~16K token 噪声里 10% / 50% / 90% 深度埋针 |
| `cost-per-correct` | 跟上面同题,但指标是每答对一题花多少 USD |
| `tool-sequence` | 3 步 JSON 工具调用计划,对照预期顺序 |
| `agent-trajectory` | 计划+推理输出,按轨迹有效性+长度打分 |
| `latency-under-budget` | multi-turn-memory 在 2s wall + 256 token 输出预算下 |

**全部 6 个套件用合成 / 手写题。** 不与公开训练语料(GSM8K / MMLU / IFEval / HumanEval / Alpaca 等)重叠 — 这是数据卫生的硬性选择,防止学术基准上微调过的模型偷偷拿分。

学术基准要跑,用 [`lm-evaluation-harness`](https://github.com/EleutherAI/lm-evaluation-harness) 然后导入 JSON;本包专攻那些基准不覆盖的维度。

## Pareto 优先报告

Summary 表把每个 (model, suite) 单元格标记 Pareto 前沿:当**没有别的模型**同时满足"准确度不低 + 成本不高 + p95 wall 不慢",至少一个严格胜出时,该模型就在前沿。这是真正决定模型上线选哪个的信息 — 单数字准确度排名跟交易决策面相比是噪声。

实战例子:之前的 5 模型 LongMemEval 测试中,0.94 GB Q3_K_M 模型和 4.12 GB FP16 模型都拿到 5/6 = 83% 准确度。Pareto 把 0.94 GB 标在前沿(同准确度 + 更小内存 + 相近延迟)。学术只看准确度的表你看不到这个区分。

## 内置统计学纪律

每份报告都包含:

- 跨 seed 池化准确度 ± 95% Wilson CI
- 跨 seed 标准差 σ(σ 高 = 结果噪声大,声明不可靠)
- 跟 baseline 比的池化配对 McNemar p 值

`buildG1Report` API(也从 `@agentkit-js/evals-runner` 导出)对齐严肃模型评测领域的 ≥3-seed 纪律:**单 seed greedy 点估计不构成证据**。

## 编程式 API

```ts
import { runEvaluation, multiTurnMemorySuite, renderReportMarkdown } from "@agentkit-js/evals-runner";

const report = await runEvaluation({
  models: [
    { id: "qwen", baseUrl: "http://localhost:11434/v1", modelId: "qwen2.5:0.5b" },
    { id: "gpt", baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY,
      modelId: "gpt-4o-mini", pricePer1MInput: 0.15, pricePer1MOutput: 0.60 },
  ],
  suites: [multiTurnMemorySuite],
  seeds: [0, 1, 2],
});

await fs.writeFile("eval.md", renderReportMarkdown(report));
```

`report` 包含 `cells`(逐 (模型, seed, 题) 结果)、`aggregates`(逐 (模型, 套件) 汇总)、`pareto`(逐套件非支配前沿)。三个都暴露,方便消费者自己再做 dashboard。

## 自定义评测套件

```ts
import type { BenchmarkSuite } from "@agentkit-js/evals-runner";
import { exactMatch } from "@agentkit-js/core";

const myBenchmark: BenchmarkSuite = {
  name: "my-domain-suite",
  title: "客户支持 QA 回忆",
  description: "内部工单 — 不在任何训练集里",
  items: [
    { id: "T1", task: "高级套餐的 SLA 是多少?", expectedAnswer: "4 小时" },
    // …
  ],
  scorers: [exactMatch],
};

await runEvaluation({ models, suites: [myBenchmark] });
```

`@agentkit-js/core/evals` 里的 10 个 scorer (`exactMatch`、`toolCallAccuracy`、`trajectoryValidity`、`efficiencyScorer`、`constraintScorer`、`recoveryScorer`、`faithfulnessScorerAsync`、`relevanceScorerAsync`、`compositeScorer`,加 `JudgeScorer`)开箱即用。

## 见

- [`packages/evals-runner/README.md`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/evals-runner#readme) — 包级别细节、安装、完整 API。
- [`docs/zh/guides/openai-compat-recipes`](./openai-compat-recipes.md) — Ollama / OpenRouter / AI Gateway / DeepSeek / Groq 配方。
- [`docs/zh/benchmarks`](../benchmarks.md) — 主基准比例表,本 runner 是它的扩展。
