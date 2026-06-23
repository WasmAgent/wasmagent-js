# 目标导向 Agent：为什么你应该停止写单次循环

> **TL;DR。** 普通的"工具调用 agent"只跑一次，然后输出模型认为已完成的内容。
> **目标导向 agent** 会自行综合出成功标准，用确定性手段（最后才借助对抗性 LLM 评判）
> 进行验证，并在通过之前*带着反馈循环*——或者明确告诉你还差什么。
> wasmagent 将其作为一等原语提供：`GoalDirectedAgent`。大多数使用 wasmagent
> 的团队不会去用它，大多数使用*任意*框架的团队也没有它。这个差距，正是交付质量的来源。

---

## 默认循环的问题

几乎所有 agent 教程——包括 `getting-started.md` 里的示例——都展示一个
`ToolCallingAgent` 运行一次并输出 `final_answer`：

```ts
const agent = new ToolCallingAgent({ model, tools });
for await (const ev of agent.run("write a doc explaining quasi-dry batteries")) {
  // …将事件传递给 UI
}
```

这是一个**单次循环**。模型自己决定何时完成。如果模型认为提纲就等于完整文档，你得到的是提纲。如果它忘了某一节，你得到五节而不是六节。如果用户想要 1500 字而模型写了 700 字，你就只有 700 字。整个运行中没有独立的一方会问"这真的达到了用户的目标吗？"

由此产生三种病症：

1. **提纲癌。** 长篇生成任务（"写一篇 X 的介绍"）退化为目录，因为模型把列出结构视为已经交付。我们在生产中亲历过——用户要求一篇技术介绍，agent 保存了 718 字节的提纲并宣告完成。
2. **奖励塑形输出。** 当模型只以"没有抛出异常就停止"来评分时，它会尽早停止。简短在局部上是最优的，即使全局上是错的。
3. **没有确定性反馈。** 当答案出错时，没有可以回传的结构化错误。用户必须阅读输出，发现问题，打出抱怨，然后祈祷下次会更好。

这就是目标导向循环的价值所在。

## 目标导向增加了什么

`GoalDirectedAgent`（在 v0.x 版本中加入，见
[`packages/core/src/agents/GoalDirectedAgent.ts`](../../packages/core/src/agents/GoalDirectedAgent.ts)）
每个任务运行五个阶段：

```
                用户任务："write an intro to half-wet batteries"
                  │
                  ▼
   ┌───────── 阶段 0：侦察 ──────────────────────────────────┐
   │ 列出工具、快照工作区文件、浮现记忆提示                     │
   └────────────────────────────────────────────────────────┘
                  │
                  ▼
   ┌───────── 阶段 1：综合标准（1 次 LLM 调用）───────────────┐
   │ 提示词："什么能让这个任务被明确证明已完成？"               │
   │ → 返回 Criterion[]（file_size_min: 1500，headings≥4，    │
   │     llm_judge: 涵盖原理/类型/应用/未来……）               │
   └────────────────────────────────────────────────────────┘
                  │
                  ▼
   ┌───────── 阶段 2-4：GoalAgent 循环 ──────────────────────┐
   │  while !verified and iter < maxIter:                     │
   │    ToolCallingAgent.run(task + criteria)    ← 阶段 2-3  │
   │    VerificationPipeline.run(criteria)       ← 阶段 4    │
   │    if pass → break; else 将提示注入下一次迭代            │
   └────────────────────────────────────────────────────────┘
                  │
                  ▼
              goal_directed_done 事件
              { outcome, iterationCount, criteria, verdicts… }
```

关键的结构性变化：

| | 单次 ToolCallingAgent | GoalDirectedAgent |
| --- | --- | --- |
| 谁决定"完成"？ | 执行模型本身。 | 一套独立的确定性 + 对抗性 LLM 检查流水线。 |
| 输出不好时怎么办？ | 用户发现，重试。 | 循环捕获，把失败作为提示注入，自动重试。 |
| 长度/结构合规性 | "相信我就好。" | 机械检查（`file_size_min`、`headings_count_min`、`word_count_min`）。 |
| 主观质量（涵盖主题、行文地道） | 不检查。 | `llm_judge`，默认失败 + k-of-N 投票。 |
| 可见性 | 仅最终答案。 | UI 可看到标准、每次验证结果、每次重试提示。 |

这种不对称非常明显：单次 agent 产出*看起来像*工作成果；目标导向 agent 产出的是*能通过检查*的成果。

## 什么时候用这个工具

当以下**至少一条**成立时，选择 `GoalDirectedAgent`：

- 输出具有用户关心的可验证属性（长度、结构、"测试通过"、"构建成功"、"文件中存在某个特定函数"）。
- 任务足够长，方向错误的第一次尝试会浪费用户的一轮交互。
- 多次迭代是可接受的成本（循环是选择性开启的，因为它确实更贵——见下方"成本形态"）。
- 你希望 UI 能*展示*成功标准是什么（标准对用户可见，这是产品差异化的切入点）。

以下情况选择 `ToolCallingAgent`（默认）：

- 任务简短，错误答案可以廉价重跑。
- 用户想聊天，而不是交付一个制品。
- token 成本是主要考虑因素（例如嵌入在高并发后端中）。

当**你，作为操作者**，能够自己写验证函数时——运行测试、检查特定谓词、轮询外部系统——选择 `GoalAgent`（没有 `Directed`）。`GoalDirectedAgent` 是它上面的一层，由 **agent 自身**从自由形式的任务描述中综合出验证器。

## 这不是什么

它不是以下任何东西的替代品——这些仍然是 wasmagent 的其他差异化维度：

- **多 provider 模型适配器**（`@wasmagent/model-anthropic`、`model-doubao`、`model-qwen`、`model-zhipu`、`model-deepseek`、`model-moonshot`、`model-minimax`、`model-local`）——自带你选择的 vendor。
- **多运行时 kernel**（`kernel-pyodide`、`kernel-quickjs`、`kernel-wasmtime`、`kernel-remote`）——在符合你安全和计算约束的形式下执行生成的代码。
- **记忆层**（`MemoryBlockSet`、`Checkpointer`、结构化观察记忆）——wasmagent 不强制你做选择。
- **工作流引擎**（`LocalWorkflowEngine`、`CloudflareWorkflowEngine`）——持久、可恢复、可检查点的多步流程。
- **Code-mode**（单一 `execute_code` 工具，将 N 个 MCP 工具压缩为一个）——工具注册表增长时大幅降低每次调用的 token 成本。
- **AG-UI**（从 UI 到 agent 的类型化入站通道）——前端工具和 JSON-Patch 状态增量，不再受自由形式消息的脆弱性困扰。
- **Devtools / OTel exporter**（`packages/devtools`、`packages/otel-exporter`）——每个 agent 步骤都是可检查的 span。

`GoalDirectedAgent` 是**第八个维度**：循环原语。它与以上所有内容组合使用（例如使用不同 provider 的 LLMJudge；运行 WASM 测试的验证器；触发目标导向子步骤的工作流）。它不替代任何东西，而是提升这些部件所能达到的上限。

## 对抗性默认值——请务必阅读

LLM-as-judge 是奖励作弊风险的关键点。相关文献（[Loop Engineering](./loop-engineering.md)，其中引用的 RLVR / Rebound 论文）明确指出：当 LLM 为自己的工作评分时，循环会退化为走过场。

`LLMJudgeVerifier` 的设计是要推回，而不是妥协：

1. **默认失败。** 评判 prompt 指示模型在不确定或制品缺少重要内容时返回 `pass: false`。如果回复无法解析，schema 同样默认为 `false`。
2. **K-of-N 投票。** 默认 `samples=3`，默认策略 `requirePassMajority=false`——即**三次**都必须通过。任意一次异议就使该标准失败。（你可以放宽为多数通过，但默认值的存在有其原因。）
3. **独立评判模型。** `judgeModel` 是 `GoalDirectedAgentOptions` 上的一个独立字段。在重要场合使用比执行者更强或对齐方式不同的模型，以减少自我评分虚高。
4. **优先确定性。** 阶段 1 的提示词引导模型只在没有机械检查能胜任时才使用 `llm_judge`。长度、结构、标识符存在性、正则模式——这些都优先走 `DeterministicVerifier`。
5. **标准可见。** UI 消费者会在执行开始前收到完整的 `criteria_proposed` 事件。如果综合出的标准很弱，用户在循环浪费迭代次数*之前*就能看到。

这些默认值故意设置得很严格。放宽是允许的——构造函数接受覆盖参数——但任何这样做的人都应该先阅读 loop-engineering 指南。

## 成本形态

每个任务，`GoalDirectedAgent` 额外增加：

- **一次综合调用**（阶段 1，约 1-2k token；建议使用廉价模型）。
- **每个 `llm_judge` 标准每次迭代 K 次评判调用**。默认（`samples=3`），即 `3 × #llm_judge_criteria × iterations`。
- **迭代本身**——与原始 `ToolCallingAgent` 相同的成本，但乘以 `iterationCount`（由 `maxIterations` 封顶）。

实践中，简单任务（综合返回 1-2 个确定性标准，执行器一次就通过）比单次 ToolCallingAgent 运行约增加 ~10-15%。困难任务（3-5 次迭代，多个 `llm_judge` 标准）可能运行 3-5 倍。`tokenBudget` 选项可封顶总花费；另见 `synthModel`（用于综合的廉价模型）和 `judgeModel`（独立评分者）。

**选择性开启**的姿态是有意为之的。wasmagent 的产品伙伴将其作为 UI 开关（"循环直到验证通过"）而不是默认选项暴露——因为对于日常聊天，额外的成本是浪费。

## 最小可用用法

```ts
import { GoalDirectedAgent } from "@wasmagent/core";

const agent = new GoalDirectedAgent({
  model: executor,            // sonnet 4.6
  synthModel: synth,          // haiku 用于廉价标准综合
  judgeModel: judge,          // 独立评分者
  tools: yourTools,
  workspaceReader: yourWs,    // 供验证器使用的只读窗口
  scout: {
    tools: yourTools.map((t) => ({ name: t.name, description: t.description })),
    workspaceEntries: await yourWs.listTopLevel(),
  },
  maxIterations: 3,
  judgeSamples: 3,
});

for await (const ev of agent.run(userTask)) {
  // ev.event ∈ {scout_done, criteria_proposed, model_done,
  //             tool_call, tool_result, goal_iteration_start,
  //             goal_directed_done, …}
  switch (ev.event) {
    case "criteria_proposed":
      ui.showCriteria(ev.data.criteria);     // <- 产品差异化点
      break;
    case "goal_directed_done":
      ui.showFinalReport(ev.data);
      break;
  }
}
```

UI 层面——在用户看到答案之前就展示出综合好的标准——才是关键。这是"只是期望对话"与"真正能交付对话"之间可见的区别。

### 为 CI 冻结标准：`wasmagent goal --from-criteria`

对于确定性 CI 门控和 A/B 对比，你通常不希望 synth 模型每次运行都重新发明一个评分器。一次性固定标准并传入：

```bash
# 阶段 1 在第一次运行时正常执行——捕获综合出的标准。
wasmagent goal "Write the OAuth intro" --workspace ./tmp \
  --stream | tee transcript.ndjson

# 提取到 CI 提交的固定文件中。
jq -c 'select(.event=="criteria_proposed") | .data.criteria' \
  transcript.ndjson | head -1 > criteria.json

# 后续运行跳过阶段 1——每次使用相同的评分器。
wasmagent goal "Write the OAuth intro" --workspace ./tmp \
  --from-criteria criteria.json
```

编程式等价写法——直接向 `GoalDirectedAgent` 传入 `criteria`：

```ts
const agent = new GoalDirectedAgent({
  model,
  tools,
  workspaceReader: ws,
  criteria: frozenCriteriaList,  // 跳过综合，直接使用此列表
});
```

提供 `criteria` 时，综合模型不会被调用，`criteria_proposed` 事件仍会触发（携带提供的列表），以便观察者看到相同的形状。空数组仍会触发单次降级路径——与综合返回零标准的处理方式相同。

## 产品 UI 中的自动路由（bscode 模式）

面向用户的聊天产品**不应该**让用户自己选择"目标模式 vs 工具模式"。目标导向的全部意义在于*agent 自行决定*。因此推荐的产品接线方式是：

1. 保留你现有的**任务分类器**（或构建一个——一次 `claude-haiku` 调用到结构化输出端点就够了）。
2. 在分类器回复的 `mode` 轴旁边增加一个 `loop: "single" | "verify"` 轴。调度规则：

   ```ts
   const agentMode =
     classify.loop === "verify" && classify.mode !== "framework"
       ? "goalDirected"
       : classify.mode;
   ```

   `framework` 模式豁免是因为真实应用构建本身已经有自己的 plan→build→preview 循环（WebContainer 侧信道）——在上面再叠加一个验证循环是多余的。

3. **不要上线手动开关。** UI 里的 `🎯 Goal` 按钮是复杂度税：大多数用户不知道什么时候该拨它，而分类器比他们决策更好。bscode 上线了半天就被用户质疑"我为什么要选这个？"——他们说得对。

4. **要**在轮次徽章上展示分类器的选择（"Tool + DAG · 🎯"），让用户看到 agent 即将做什么。隐藏路由离"有时聊天行为不同但我不知道为什么"只有一个糟糕的 eval 的距离——可见路由才是诚实的。

分类器提示词（锚定 `loop` 轴）是产品特定的（bscode 的在 `apps/worker/src/app.ts` 的 `/classify` 路由里）。它产出的形状——`{mode, framework, loop}`——是你的调度器所映射的内容。保持 wasmagent 的 `GoalDirectedAgent` 对你如何决定调用它一无所知。

## 参见

- [`GoalAgent`](../../packages/core/src/agents/GoalAgent.ts) — 更小的原语，当你自己编写 `verify` 函数时使用。
- [Loop Engineering 指南](./loop-engineering.md) — 为什么 LLM-as-judge 需要对抗性默认值；验证循环文献综述。
- [Evals cookbook](./evals-cookbook.md) — 如何使用 evals-runner 将目标导向循环放到回归面板上。
- [Workflows 指南](./workflows.md) — 当你需要持久、可恢复的多步流程时，循环是其中的一部分。
