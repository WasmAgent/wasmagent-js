# Evals 实战手册

agentkit-js 内置 16 个 scorer，覆盖正确性、忠实度、相关性、效率、约束、恢复、护栏合规以及 LLM 担任评委等场景。本指南展示如何把它们组合起来做生产级基准评测。

## 可用 scorer

| Scorer | 同步? | 适用场景 |
|--------|-------|----------|
| `exactMatch` | sync | 确定性答案匹配 |
| `toolCallAccuracy` | sync | 工具调用顺序是否正确（基于 LCS） |
| `trajectoryValidity` | sync | tool call 是否都配了对应 result |
| `finalAnswerLength` | sync | 长度是否在目标范围 |
| `efficiencyScorer` | sync | token / 成本 / 时长 / 步数预算 |
| `constraintScorer` | sync | 硬约束（必须用工具 X、必须包含 Y） |
| `recoveryScorer` | sync | 工具失败时的恢复率 |
| `compositeScorer` | sync | 子 scorer 的加权合成 |
| `guardrailCompliance` | sync | 输出护栏触发器 |
| `llmJudge` | async | 自定义 LLM 评分（粗 0/0.5/1 三档） |
| `judgeScorer`（A4） | async | 多维加权 LLM 评分 + 分项明细 |
| `trajectoryQualityJudge`（A4） | async | 内置：效率 + 工具契合 + 自我纠错 |
| `answerCompletenessJudge`（A4） | async | 内置：覆盖度 + 可执行性 + 诚实度 |
| `faithfulnessScorer` | async | 工具输出 vs 答案的幻觉检测 |
| `relevanceScorer` | async | 与期望答案的 embedding 余弦相似度 |

## 快速上手

```ts
import { runEval, exactMatch, toolCallAccuracy, trajectoryValidity } from "@agentkit-js/core";

const dataset = [
  { id: "1", task: "2+2 等于多少？", expectedAnswer: "4" },
  { id: "2", task: "搜索 X", expectedTools: ["web_search"] },
];

const results = await runEval(dataset, (task) => agent.run(task), [
  exactMatch,
  toolCallAccuracy,
  trajectoryValidity,
]);
```

## 合成打分

把多个维度合成一个混合指标：

```ts
import { compositeScorer, exactMatch, efficiencyScorer, recoveryScorer } from "@agentkit-js/core";

const overall = compositeScorer([
  { scorer: exactMatch, weight: 0.5 },
  { scorer: efficiencyScorer({ maxTokens: 5000, maxCostUsd: 0.05 }), weight: 0.3 },
  { scorer: recoveryScorer(), weight: 0.2 },
]);
```

## 幻觉检测（异步）

faithfulness scorer 需要一个 LLM 评委 — 在 eval runner 里调它的 async 变种：

```ts
import { faithfulnessScorerAsync, collectTrace } from "@agentkit-js/core";

const events = [];
for await (const ev of agent.run(task)) events.push(ev);
const trace = collectTrace(task, events);

const result = await faithfulnessScorerAsync(
  { model: judgeModel, maxTokens: 32 },
  trace
);
console.log(`Faithfulness: ${result.score} — ${result.detail}`);
```

用便宜快速的模型（Haiku、GPT-4o-mini、DeepSeek V4 Flash）当评委可以让 eval 价格更可控。

## 通过 embedding 算相关性

```ts
import { relevanceScorerAsync } from "@agentkit-js/core";
import { HttpEmbedder } from "@agentkit-js/tools-rag";

const embedder = new HttpEmbedder({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "text-embedding-3-small",
});

const result = await relevanceScorerAsync({ embedder }, trace, sample);
// result.score 是 [0, 1] 的余弦相似度
```

## 约束（必须 / 不许）

```ts
import { constraintScorer } from "@agentkit-js/core";

const safetyCheck = constraintScorer({
  mustContain: ["disclaimer:"],
  mustNotContain: ["password", "secret"],
  mustUseTool: ["safety_check"],
  mustNotUseTool: ["delete_file"],
  maxLength: 2000,
});
```

只有 **全部** 约束满足时返回 1，否则 0。配合 compositeScorer 与连续指标平衡。

## 效率

`efficiencyScorer` 从 `model_done` 事件取 token 用量，从事件时间戳取耗时，从 `step_start` 事件取步数。

```ts
import { efficiencyScorer } from "@agentkit-js/core";

const eff = efficiencyScorer({
  maxTokens: 10_000,
  maxDurationMs: 30_000,
  maxCostUsd: 0.10,
  maxSteps: 20,
});
```

得分 = 各维度的几何平均。任一维度 0 会把总分拉到 0。

## 恢复

agent 从工具失败中恢复的能力如何？

```ts
import { recoveryScorer } from "@agentkit-js/core";

// score = 恢复次数 / 总失败次数
// 1.0 = 每次失败都恢复
// 0.0 = 一次没恢复
// 没失败时空 vacuously 算 1.0
```

## 设计真实基准

生产 agent 推荐合成：

```ts
const benchmark = compositeScorer(
  [
    { scorer: exactMatch, weight: 0.30 },          // 硬正确性
    { scorer: toolCallAccuracy, weight: 0.15 },    // 走对工作流
    { scorer: trajectoryValidity, weight: 0.10 },  // 无悬空工具调用
    { scorer: efficiencyScorer({ maxTokens: 8000, maxCostUsd: 0.05 }), weight: 0.20 },
    { scorer: recoveryScorer(), weight: 0.10 },
    { scorer: constraintScorer({ mustNotContain: ["I cannot"] }), weight: 0.15 },
  ],
  "production-quality",
);
```

异步 scorer（faithfulness / relevance）单独跑，再手动把结果折叠回来 — 如果你需要完整 async 路径。

## A4 — 多维 LLM 评委

`judgeScorer` 是 `llmJudge` 的丰富版。它接受一组 criterion（可选权重），返回每条的明细 + 合成分数。两个内置 domain judge（`trajectoryQualityJudge`、`answerCompletenessJudge`）带合理默认值，让你不写 rubric 也能开始评分。

```ts
import {
  answerCompletenessJudge,
  runJudgeScorer,
  trajectoryQualityJudge,
} from "@agentkit-js/core";

// 便宜评委 — Haiku / 豆包 / DeepSeek 都行；agent 留在 Sonnet。
const judgeModel = new HaikuModel({ apiKey: process.env.ANTHROPIC_API_KEY });

const completeness = await runJudgeScorer(
  trace,
  answerCompletenessJudge(judgeModel),
);

console.log(completeness.score);             // 0..1 加权合成
console.log(completeness.breakdown);         // 每条 criterion 的原始分 + 归一化 + 解释
```

### 自定义 criterion

传 `criteria` 覆盖默认。权重可选，会归一化到和为 1；零权重的 criterion 会被评分但不计入合成。

```ts
const reviewerJudge = judgeScorer({
  name: "code-review",
  model: judgeModel,
  scale: 5,                            // 0–5 评分而不是 0–10
  systemPersona: "你是 FinCorp 的资深 reviewer。",
  generateOpts: { temperature: 0 },
  criteria: [
    { id: "correctness",  description: "patch 是否修复了 bug?",       weight: 4 },
    { id: "tests",        description: "patch 是否添加或更新了测试?", weight: 2 },
    { id: "style",        description: "patch 是否遵循仓库约定?",     weight: 1 },
  ],
});
```

### 为什么和 `llmJudge` 分开?

`llmJudge` 返回 0/0.5/1 三档。够用于二元"通过/失败"决策但丢信号 — 一个 70% 正确的答案会塌缩到和 49% 同一个桶。JudgeScorer 通过分维度评分 + 可配置 scale 保留细粒度。冒烟测试用 `llmJudge`，生产基准用 `judgeScorer`。

### 规则 scorer 与评委 scorer 的搭配

两者互补。规则 scorer 便宜、确定、是仪表盘的锚点。评委补的是规则模式匹配不出来的细微之处（比如"答案提到了所有必须的话题但只略带一笔过了一半"）。[`judge-scorer-demo`](../../examples/judge-scorer-demo/) 示例展示了二者在合成 trace 上的分歧。
