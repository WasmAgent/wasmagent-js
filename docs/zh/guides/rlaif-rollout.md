# RLAIF 部署流水线

> **状态：** 已于 2026-06-22 发布。所有原语均从 `@wasmagent/core` 导出。

wasmagent-js 提供了一条完整的流水线，用于从实时 agent 轨迹生成 RLAIF（基于 AI 反馈的
强化学习）训练数据。该流水线连接三个项目：**wasmagent-js**（SDK 原语）、
**bscode**（用于客观 B2/C3 信号的 bscode 适配器）以及 **evomerge**（训练数据导出 + 验证）。

---

## 快速概览

```
RolloutForkRunner          ← 将 ToolCallingAgent 分叉为 N 个分支
    ↓ RolloutBranchResult[]
BuildPassesVerifier        ← exitCode=0 → objective_score=1
VisualAssertVerifier       ← visual.verdict=pass → objective_score=1
    ↓ scores[]
RolloutRanker              ← Bradley-Terry + ScalarLLMJudgeVerifier 两两比较
    ↓ RankedBranch[]
RolloutMemoryStore         ← 持久化顶级分支以供未来采样
    ↓ JSONL
evomerge TrainingDataExporter ← DPO 对 + PPO 奖励
```

---

## RolloutForkRunner

将一次 `ToolCallingAgent` 运行分叉为 N 个独立分支。每个分支运行完整的工具调用循环
并产出其完整的 `AgentEvent[]` 轨迹。

```ts
import { RolloutForkRunner } from "@wasmagent/core";

const runner = new RolloutForkRunner({
  branches: 5,
  concurrency: 5,
  temperaturePerBranch: [0.5, 0.6, 0.7, 0.8, 0.9],
  // 对于有状态的测试 mock：每个分支提供一个新的模型实例
  // modelFactory: () => new AnthropicModel("claude-sonnet-4-6", apiKey),
});

for await (const result of runner.run(agentOpts, "Build a REST endpoint")) {
  console.log(result.branchIndex, result.finalAnswer, result.toolCallSequence);
  // result.buildResult 为 null——由下面的验证器填充
}
```

`toolCallSequence` 中 `tool_result` 的输出在持久化前会自动经过 `summarizeToolOutput()` 处理。
训练数据和推理上下文始终看到相同的压缩形式。

### RolloutBranchResult 的关键字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `rolloutId` | `string` | 一次 `run()` 调用中所有分支共享 |
| `branchIndex` | `number` | 0..N-1 |
| `sessionId` | `string` | 通过 `<prefix>-b<index>-<uuid>` 派生 |
| `trajectory` | `AgentEvent[]` | 从 run_start 到 final_answer 的完整事件流 |
| `toolCallSequence` | `AgentEvent[]` | 仅 `tool_call` + `tool_result`，输出已摘要化 |
| `finalAnswer` | `string` | `final_answer` 事件中的文本 |
| `buildResult` | `null` | 由 bscode 适配器从外部填充 |

---

## BuildPassesVerifier / VisualAssertVerifier

`VerificationPipeline` 的客观信号验证器。两者都接受注入的回调，
以保持 `@wasmagent/core` 与 bscode 的 KV 通道解耦。

**关键不变式：** `status === "running"` 和 `status === "unknown"` 始终失败——
它们永远不会默认为通过。

```ts
import { BuildPassesVerifier, VisualAssertVerifier, VerificationPipeline } from "@wasmagent/core";
// bscode 特定的适配器：
import { makeBuildResultReader, makeVisualResultReader } from "bscode/rollout-adapter";

const pipeline = new VerificationPipeline({
  ws: myWorkspaceReader,
  verifiers: [
    new BuildPassesVerifier({ getBuildResult: makeBuildResultReader(kv) }),
    new VisualAssertVerifier({ getVisualResult: makeVisualResultReader(kv) }),
  ],
});

const result = await pipeline.run([
  { id: "build", description: "build passes", verify_method: "build_passes", arg: sessionId },
  { id: "visual", description: "renders correctly", verify_method: "visual_assert", arg: sessionId },
]);
```

---

## ToolOutputSummarizer

确定性的头部+尾部截断。在将工具输出存储到训练数据中**以及**传递给模型之前使用——
两者必须看到相同的压缩形式。

```ts
import { summarizeToolOutput } from "@wasmagent/core";

const compressed = summarizeToolOutput(rawStderr, {
  maxBytes: 800,       // 默认值
  keepFirstLines: 3,   // 默认值
  keepLastLines: 5,    // 默认值
});
// 较短的输出原样返回。较长的输出：前 3 行 + [...N 行省略...] + 后 5 行。
```

---

## ScalarLLMJudgeVerifier

在 `LLMJudgeVerifier` 的防奖励作弊机制基础上，增加了标量评分和两两比较。
由 `RolloutRanker` 内部使用；也可单独使用。

```ts
import { ScalarLLMJudgeVerifier } from "@wasmagent/core";

const judge = new ScalarLLMJudgeVerifier({
  model: judgeModel,          // 使用与执行 agent 不同的模型
  samples: 3,                 // k-of-N：3 次独立的评判调用
  temperature: 0.1,           // 低温度，对抗性默认值
  maxJudgeCallsPerBatch: 100, // 上限——超出的样本获得中性分数 5
});

// 评分模式（Verifier 接口）
const verdict = await judge.verify(criterion, workspaceReader);
// verdict.ok === true → verdict.score 为 0-10

// 两两比较模式
const { preferred, reasoning } = await judge.comparePair({
  criterionDescription: "code quality and correctness",
  outputA: branchA.finalAnswer,
  outputB: branchB.finalAnswer,
});
```

---

## KernelPool

`WasmKernel` 实例的有界并发池。每次 rollout 批次使用一个池；
每个分支通过 rollout ID 获取一个 kernel 槽位。

```ts
import { KernelPool } from "@wasmagent/core";
import { RemoteSandboxKernel } from "@wasmagent/kernel-remote";

const pool = new KernelPool({
  factory: () => new RemoteSandboxKernel({ apiKey: process.env.E2B_API_KEY }),
  maxConcurrent: 16,
});

const kernel = await pool.acquire("rollout-id-abc");
const result = await kernel.runCommand("npm install");
await pool.release("rollout-id-abc");

await pool[Symbol.asyncDispose](); // 清理所有 kernel
```

---

## RolloutRanker

通过客观分数 + 评判两两比较对 N 个分支进行排名。

```ts
import { RolloutRanker } from "@wasmagent/core";

const ranker = new RolloutRanker({
  judge,                       // ScalarLLMJudgeVerifier
  judgeCriterion: "overall quality and correctness",
  rewardFunctions: [
    { key: "objective", weight: 1.0, score: r => r.objectiveScore },
    { key: "judge",     weight: 0.3, score: r => (r.judgeScore ?? 5) / 10 },
  ],
});

const { ranked, stats } = await ranker.rank(records);
// ranked[0] 是最优分支
// stats.powered: n < 10 时为 false——结果不具决定性
```

报告始终包含 `powered: boolean` 和 `minDetectableDeltaPp`。
当 `powered === false` 时，将排名视为尽力估计，而非统计显著的结论。

---

## RolloutMemoryStore

持久化高质量分支经验以供未来采样。只有 `objectiveScore === 1` 的分支会被存储；
score-0 的分支被静默丢弃，以防污染数据。

```ts
import { RolloutMemoryStore } from "@wasmagent/core";
import { InMemoryVectorStore } from "@wasmagent/core"; // 或 Pinecone/Qdrant

const store = new RolloutMemoryStore({ store: retriever });

// 排名后——存储获胜分支
await store.upsert({ rolloutId, branchIndex, task, keySteps, objectiveScore: 1, finalAnswer });

// 下一次分叉批次前——注入相关的历史经验
const memories = await store.retrieve(task, 3);
const injection = RolloutMemoryStore.formatAsSystemPrompt(memories);
// 将 `injection` 前置到 agentOpts 中的 system prompt
```

---

## 端到端示例

```ts
import {
  RolloutForkRunner,
  RolloutRanker,
  RolloutMemoryStore,
  KernelPool,
  ScalarLLMJudgeVerifier,
  BuildPassesVerifier,
} from "@wasmagent/core";
import { RemoteSandboxKernel } from "@wasmagent/kernel-remote";
import { makeBuildResultReader } from "bscode/rollout-adapter";

// 1. 分叉 N 个分支
const runner = new RolloutForkRunner({ branches: 8, concurrency: 8 });
const results = [];
for await (const r of runner.run(agentOpts, task)) results.push(r);

// 2. 用客观信号评分
const verifier = new BuildPassesVerifier({ getBuildResult: makeBuildResultReader(kv) });
for (const r of results) {
  const v = await verifier.verify(
    { id: "build", description: "build passes", verify_method: "build_passes", arg: r.sessionId },
    ws
  );
  r.objectiveScore = v.ok ? 1 : 0;
}

// 3. 排名
const judge = new ScalarLLMJudgeVerifier({ model: judgeModel });
const ranker = new RolloutRanker({ judge });
const { ranked, stats } = await ranker.rank(results);

// 4. 存储获胜者供下一轮使用
const memStore = new RolloutMemoryStore({ store: retriever });
for (const r of results.filter(r => r.objectiveScore === 1)) {
  await memStore.upsert({ ...r, keySteps: r.toolCallSequence.map(e => e.data?.toolName).join(" → ") });
}

// 5. 导出到 evomerge
// python -m datafactory.exporter --input rollouts.jsonl --output-dpo dpo.jsonl --output-ppo ppo.jsonl
```

---

## 统计严谨性

每份排名报告包含：

- `powered: boolean` — `n < 10` 或 Wilson 置信区间半宽 ≥ 30pp 时为 False。
- `minDetectableDeltaPp` — 最小可检测的通过率差异。
- `mcnemarP` — 对上下两半的 McNemar 精确检验 p 值（n < 4 时为 null）。

当 `powered === false` 时，排名是启发式估计。
只有在 `powered === true` 且 `mcnemarP < 0.05` 时，才应将排名作为证据。
