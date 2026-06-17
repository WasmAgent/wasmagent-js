# Post-Training Leverage Plan (2026-06-17)

> Source trigger: Tw93 「为什么说大模型训练很难？」综述。读后讨论 → 把"后训练栈机制"映射到 agentkit-js / bscode / evomerge 三个项目。
>
> **Status**: Draft v1，待与用户共同迭代。引用文献已部分核实（见 §6）。

---

## 0. 决策框架

文章的核心论点是：2026 年模型能力差距越来越**不**来自预训练本身，而来自**预训练后面那一整段流水线**——后训练 SFT/RL、verified rewards、grader、harness、轨迹、蒸馏、deploy loop。

把这个论点映射到我们三个项目，关键判断是：

| 项目 | 角色 | 在文章框架里属于哪一层 |
|------|------|----------------------|
| **agentkit-js** | 通用 SDK / Agent 基础设施 | 提供 **harness 原语 + verified-reward graders + trajectory 序列化**，不做训练本身 |
| **bscode** | Production coding agent (CF Workers + Next.js) | 是一个 **production agent harness**，每天产生真实多轮 tool-use 轨迹 |
| **evomerge** | 模型搜索 / 合并 / SFT / 量化 | 训练栈本身，**消费**前两者产出的数据和评测，目标 Pareto-optimal models |

agentkit-js 必须保持通用（[[feedback_agentkit_generic_foundation]]），产品概念留 bscode；evomerge 是研究/工程项目，关心训练数据形态和 reward 信号。

---

## 1. 文章里 8 条可执行机制

把文章压成 8 条工程机制（不是观点）：

| # | 机制 | 一句话 |
|---|------|--------|
| M1 | **后训练四阶段流水线** | 冷启动 SFT → verified-reward RL → rejection sampling → 偏好对齐 |
| M2 | **Verified rewards 优先** | 数学/代码/逻辑可程序验证 → reward 信号比人工偏好稳 |
| M3 | **PRM > ORM（在可验证任务里）** | 给中间步骤打分挡住 reward hacking；代价是需要可自动化过程验证器 |
| M4 | **Reward hacking / alignment faking 是工程问题** | grader / 环境隔离 / 监控当训练设计的一部分 |
| M5 | **Harness 是一等公民** | 模型外层程序本身就是能力的一部分；可被外循环搜索/优化（Meta-Harness） |
| M6 | **Agent 训练 = 训练编排层 + 稳定环境** | Kimi PARL 只训 orchestrator + 三类奖励 |
| M7 | **轨迹是新货币** | 大模型 RL 出的成功 rollouts → 蒸馏给小模型；能力解耦 |
| M8 | **Real-time RL / 生产流量回流** | Cursor Composer 2 把 long coding session 接回训练 |

---

## 2. 对 agentkit-js 的提议

### A1 — `Harness` 一等概念（高把握 · 1-2 天）

**现状**：我们已经有 WorkflowEngine（[[workflow_engine_deliver_2026_06_17]]）、ResourcePool、MemoryBlockSet、GoalAgent。但 "harness" 这个词在我们包里**没有显式存在**，散落在各处。

**提议**：定义 `Harness` 接口，把 prompt construction / context editing / memory update / tool orchestration / rollout 作为可组合 stage。

**约束**：
- 纯 SDK 层，不引入产品概念
- 不带 proposer / 不绑定特定模型
- 可被外部（包括 Meta-Harness 风格的 meta optimizer）当成可优化对象

**不做**：A4 — 把 harness 自己当外循环优化对象。这一层留给研究项目（evomerge 或 future fork）。

### A2 — Trajectory recording + replay 原语（高把握 · 1-2 天）

文章 M5 反复出现 "execution traces 写进 filesystem，proposer grep/cat/diff 改 harness"。Meta-Harness 论文具体做法：把 prior code、scores、execution traces 全部写 filesystem，proposer 做 10M tokens/step 的 diagnostic 上下文。

我们 WorkflowEngine 已经有 step-level 持久化（[[workflow_engine_deliver_2026_06_17]] 提到 deferred step re-dispatch bug 就是靠 WF_TRACE log 抓到的）。把这个能力**外化为公共 API**：

```ts
trajectory.export(): TrajectoryRecord       // 落 JSONL / .agentkit-trajectory/
trajectory.replay(): AsyncIterable<Step>     // 重放，给 grader / debugger
trajectory.diff(other): TrajectoryDiff       // 两次 run 的步骤级差异
```

**用途**（不止训练）：
- bscode 调试（"我刚才那个 session 哪步开始跑偏"）
- evals-runner 回归
- evomerge 训练数据来源
- 用户排错

### A3 — `@agentkit-js/evals-runner` 加 verified-reward graders（高把握 · 1-2 天）

**现状**：evals-runner 已存在（[[strategic_plan_2026_06_12]]），跑 LongMemEval / MAB / LoCoMo。

**提议**：补 `graders/` 子目录，提供 M2/M3 的几类典型 grader：

```
graders/
  orm/
    exactMatch.ts
    regex.ts
    numericTolerance.ts
    jsonSchemaConforms.ts        ← 这一类已经 verified（程序判定）
    codeRunsAndPasses.ts         ← run testCases，binary pass/fail
    mathSymbolicEqual.ts         ← sympy-style 等价
  prm/
    processGrader.ts             ← 接收 step validator，给中间步骤打分
    toolCallShape.ts             ← bscode/evomerge 都用得上：tool-call schema 合规
    intermediateStateConsistency.ts
```

**目标**：让 evals-runner 不只是"跑评测"，而是**提供训练所需的 reward 信号**。直接打通 §3 evomerge 协作。

### A4 — Meta-Harness 风格的元优化（**不做**）

理由：
- 通用基础原则 [[feedback_agentkit_generic_foundation]]：绑定 proposer 模型违反原则
- 研究层面的事，留给 evomerge 或 fork
- 论文是 ACM CAIS 2026 Workshop（Oral），还没充分外部复现

替代：把 A1+A2 做扎实，让别人能把 agentkit-js 当成 Meta-Harness 的 runtime。

### A5 — 训练流水线本身（**不做**）

训练栈在 evomerge，不在 agentkit-js。SDK 提供轨迹 / grader / harness 三件，不提供 trainer。

---

## 3. 对 bscode 的提议

bscode 在 M5/M6/M8 的甜点位置：**它本身就是 production agent harness**，每天产生真实 coding 轨迹。

### B1 — Session 轨迹导出（高把握）

**目标**：让 bscode 用户能一键导出脱敏后的 session 轨迹（tool calls / file diffs / final outcome / 用户 accept/revert）。是 A2 在 bscode 侧的具体落地。

**两个用途**：
1. 给 evomerge 提供**真实 multi-turn tool-using trajectory**（见 §4）
2. 给 bscode 用户提供"哪步开始跑偏"的调试

**关键依赖**：用户授权 + 脱敏管线（数据治理问题，不是工程问题）。

### B2 — Verified outcome 标签显式化（高把握）

文章 M2/M4：reward signal 越能程序验证越稳。bscode 当前成功信号是隐式的（用户接没接受 diff、有没有 revert、有没有继续追问）。

**提议**：在 UI 给 session 加轻量 verified outcome：
- `tests_passed` / `build_passed` / `user_accepted` / `user_reverted`

短期价值：bscode session quality 看板。
长期价值：每条导出轨迹自带 reward label，B1 + A3 直接打通到 evomerge SFT。

### B3 — Environment bootstrap（中把握 · 待 audit）

Meta-Harness 在 TerminalBench-2 上**自动发现**的最有效改进之一：agent loop 开始前先跑 shell 命令，把 cwd / 可用语言 / 包管理器 / 内存状态做成快照注入首轮 prompt。

**TODO**：审计 bscode worker 的 prompt 构造路径，看是否已做。如果没做，是低成本高回报改动。

文章原话："很多 coding agent 前几轮其实都在探环境，这层前置做好，提升不一定来自更强权重，而是 harness 让模型一开始就站在更好的上下文上。"

### B4 — PARL 风格多 agent 编排（**先调研，不做**）

bscode 当前应该是单 agent 串行（**待验证**）。Kimi PARL 的洞见：只训 orchestrator + 三类奖励驱动并行分解。

判断：**先用 B1 的轨迹数据看实际任务分布**，再决定要不要做。不要被论文带节奏。

---

## 4. agentkit-js → evomerge 训练素材 pipeline

这是三个项目里**协作度最高**的一条线。区分两类素材：

### 4.1 静态评测数据（已经在做）

evomerge 跑 arm-c / arm-f / MAB / LoCoMo / MMLU 等。agentkit-js evals-runner 已经在提供。**继续做就是了**，A3 verified-reward graders 是直接增量。

### 4.2 Agent 轨迹数据（这是文章 M7 的真正信号）

文章 M7：**大模型 RL 产生的成功 rollouts → 蒸馏给小模型**。这是 evomerge 真正缺的东西。

evomerge 之前 SFT v3 在 arm-f 上 -21pp 退步（[[run_h_sft_diagnostic_2026_06_15]]），原因是 "training-data-vs-arm-f shape mismatch"——**训练数据形态和评测形态不匹配**。

**evomerge 当前已知格式**（来自 2026-06-17 调研，§5 详细）：

evomerge 已经在用 **multi-turn tool-using JSONL**（OpenAI tool_calls 风格 messages 数组），不是单轮 QA。schema：

```json
{
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "Read <path>, then rename to <newpath>."},
    {"role": "assistant", "content": "", "tool_calls": [{"id":"c1","type":"function","function":{"name":"read_file","arguments":"{...}"}}]},
    {"role": "tool", "tool_call_id": "c1", "content": "{\"content\":\"...\"}"},
    {"role": "assistant", "content": "DONE", "final_answer": true}
  ],
  "loss_weight_tokens": "recovery",
  "provenance": {"source": "evomerge/t10-generated-v1", "v1_item_id": "fs-1step-read", "n_gram_hash": "sha256..."}
}
```

**这个格式 agentkit-js / bscode 都能产出**——bscode 的 session trace 重排成这个 schema 是机械变换。

### 4.3 提议的 pipeline

```
┌─────────────────────────────────────────────────────────────┐
│ agentkit-js                                                  │
│   - A1 Harness                                               │
│   - A2 Trajectory recording (导出 OpenAI tool_calls 格式)    │
│   - A3 Verified-reward graders                               │
└─────────────────────────────────────────────────────────────┘
              ↓ SDK
┌─────────────────────────────────────────────────────────────┐
│ bscode (production agent)                                    │
│   - B1 真实 coding session 持续产生轨迹                      │
│   - B2 每条轨迹带 verified outcome (build_passed / ...)     │
└─────────────────────────────────────────────────────────────┘
              ↓ 脱敏 + 过滤后导出
┌─────────────────────────────────────────────────────────────┐
│ evomerge                                                     │
│   - 用真实 agent 形态轨迹做 SFT/rejection sampling          │
│   - shape 和评测时使用形态一致 → 解决 v3 -21pp 类似问题      │
│   - 文章 M1 rejection sampling: 高分 rollout → 下轮 SFT data │
└─────────────────────────────────────────────────────────────┘
```

**关键：bscode session 在脱敏后是真实分布**，比 evomerge 现在用的 `t10_generate_traces.mjs` 合成数据严格更高质量（v8 用了 ~15k 合成 items，仍 38.9% 距 56% 目标 17pp）。

---

## 5. evomerge 仓库现状（2026-06-17 调研）

### 5.1 整体

- **路径**：`/Users/I041705/github/evomerge`
- **栈**：Python (transformers + Trainer + mergekit) + Node.js (T10 数据生成)
- **核心目标**：Pareto-optimal models under customer constraints (size / accuracy / latency)
- **三宪法门**（CLAUDE.md §0.2）：
  - **G1**：目标指标 ≥ 阈值（McNemar p<0.05，≥3 seeds）
  - **G2 (Locality)**：GSM8K/IFEval/MMLU 各 Δ ≤ −1.0pp（无回归）
  - **G3 (Data isolation)**：训练-评测严格不重叠（n-gram + provenance）

### 5.2 当前主线：T10 Multi-turn Tool-Use SFT

- **目标**：arm-f ≥56%（Wilson lower bound ≥50% @ n=90）
- **最新进展**：
  - v3 → v7f (1.7B Qwen3)：20.0% → 38.9%（Wilson 95% CI [29.5, 49.2]，752 steps）
  - **v8 训练完成**（997/997 steps，LoRA 合并 NaN=0，Q4_K_M GGUF + Ollama 已导入 `evomerge-t10-1b7-v8:latest`）
  - **Run N 评测进行中**（180 cells，~15 min）← **2026-06-17 用户最新更新**
- **G1 仍 FAIL**（38.9% << 56%，仍 17pp 差距）；G2/G3 已 PASS；Phase 16 audit 完成（去污染后 LoRA −0.7pp 而非原 +4.1pp，发表 honest negative result）

### 5.3 v3 → v8 的根因诊断

来自 evomerge CLAUDE.md §3 "SFT 调试三步诊断法"：
- v1/v2 失败：bfloat16 label 截断 → loss=NaN
- v3 修：fp32 + label masking → 20% 起步
- v4-v7 plateau：cal-3step（calendar 3-step 任务）+ fs-4step（file-system 4-step 任务）严重欠采样
- **v8 fix**：discovery-first 数据增强，扩到 ~15k+ items，对 cal-3step / fs-4step 重点补充

### 5.4 关键发现：evomerge 已经把 agentkit-js 当 SDK 用

```bash
node /Users/I041705/github/agentkit-js/examples/benchmarks/multi-turn-scaffold-ablation.mjs \
  --base-url http://localhost:11434/v1 \
  --models <lora-merged-tag> \
  --arms bare,param-only \
  --seeds 0,1,2 --concurrency 1 --no-warmup \
  --out outputs/mt-sft-eval
```

evomerge 的评测 harness 是 agentkit-js 的 `multi-turn-scaffold-ablation.mjs`。这意味着 **A1+A2 提议如果落地，evomerge 是直接受益方**。

### 5.5 数据生成现状

- T10 数据由 `scripts/t10_generate_traces.mjs` **合成**，不是来自真实 production
- starter dataset 在 `agentkit-js/datasets/multi-turn-sft-starter/`（40 records，[[run_h_sft_diagnostic_2026_06_15]]）
- v8 用 ~15k 合成 items，G1 仍然 38.9% << 56%

**这就是 §4.3 pipeline 的直接论据**：bscode B1 真实轨迹是更准的 shape，可能直接补足合成数据撑不起的部分。

---

## 6. Meta-Harness 论文核实（2026-06-17）

文章里的"6× 性能差距 / 1/4 context tokens / +7.7 pts / +4.7 pts"——**直接 fetch yoonholee.com/meta-harness 核实**：

| 转述 (Tw93) | 核实结果 | 来源 |
|---|---|---|
| 6× 性能差距 | **未在论文页面找到原文 6× 表述**。最接近的是 TerminalBench-2 demo 19-task subset，28.5% → 46.5%（**+18 pts**，约 1.6×）。完整 89 任务上是 Opus 4.6 76.4% (#2) / Haiku 4.5 37.6% (#1)。 | 简化或转述 |
| online text classification +7.7 pts vs ACE | ✅ **48.6% vs ACE 40.9% = +7.7 pts** | 论文 §Results |
| context token 用量压到 1/4 | ⚠️ **方向对，数字不严**。表里 ACE 用 203K ctx，Meta-Harness 用 45.5K，是 **4.5× 更省** 不是"1/4"。 | 论文 §Results 表 |
| 200 IMO-level 题，5 held-out models +4.7 pts | ✅ **34.1% → 38.8% = +4.7 pts avg** | 论文 §Math Reasoning |
| TerminalBench-2 environment bootstrap 例子 | ✅ 论文 demo stepper 展示 iter 1→7 演化，agent loop 前注入 cwd / 语言 / 包管理器快照 | 论文 §Demo |

**作者 / 出处**：Yoonho Lee, Roshen Nair, Qizheng Zhang, Kangwook Lee, Omar Khattab, Chelsea Finn — Stanford IRIS Lab。**ACM CAIS 2026 Workshop (Oral)**。
- Paper: https://arxiv.org/abs/2603.28052
- Code: https://github.com/stanford-iris-lab/meta-harness
- Artifact: https://github.com/stanford-iris-lab/meta-harness-tbench2-artifact

**结论**：Tw93 文章在 Meta-Harness 部分**方向准确但数字偏简化**。引用论文做技术决策时，以 yoonholee.com/meta-harness 为准；6× 那个数字别引。

---

## 7. 选项与下一步

### 优先级建议（我倾向）

| Order | Track | 工作量 | 把握度 | 最大受益方 |
|-------|-------|--------|--------|-----------|
| 1 | **A2 Trajectory recording**（agentkit-js） | 1-2 天 | 高 | 全员，evomerge 直接受益 |
| 2 | **A3 Verified-reward graders**（agentkit-js） | 1-2 天 | 高 | evomerge SFT/RL reward signal |
| 3 | **B3 Audit & 补 environment bootstrap**（bscode） | 0.5 天 | 中 | bscode 用户体验 + 间接喂 trajectory |
| 4 | **B2 Verified outcome 标签**（bscode） | 0.5-1 天 | 高 | bscode + 给 §4.3 pipeline 喂 reward label |
| 5 | **A1 Harness 一等概念**（agentkit-js） | 1-2 天 | 高 | 长线品牌一致性 |
| 6 | **B1 Session 轨迹导出**（bscode） | 1-2 天 + 数据治理 | 高（工程）/ 中（治理） | evomerge 真实分布 SFT 数据 |

### 等 evomerge Run N 结果再决定的几件事

1. **如果 v8 ≥56%**：G1 PASS，T10 主线可以收尾。问题转向：**下一组任务**用什么轨迹喂？这时 B1 的真实 bscode 轨迹会比合成更值得做。
2. **如果 v8 仍 <56%**：诊断 cal-3step/fs-4step 是否仍欠采样；继续合成。这时 A3 的 PRM grader（给中间步骤打分）会立刻有用，能更精确指出哪步学不到。
3. **如果 v8 出现新的 shape mismatch**：A2 trajectory diff 立刻有用——直接对比训练 trajectory 和评测 trajectory 的步骤级差异。

---

## 8. Open Questions

- **Q1**：bscode 当前 prompt 构造是否已经做了 environment bootstrap？（B3 是否需要做）
- **Q2**：bscode 是否已有用户授权框架？（B1 数据治理前置）
- **Q3**：evomerge 是否愿意把 trainer 端的 SFT data loader 改成消费 agentkit-js trajectory schema？还是希望我们这边输出 evomerge 现成的 JSONL？（应该后者，已有 v8 pipeline）
- **Q4**：Run N 评测结果出来后，v8 是否触发 G1 PASS？决定下一阶段优先级。

---

## 9. 不做的事（明确边界）

- ❌ 把 RL trainer 放进 agentkit-js（[[feedback_agentkit_generic_foundation]]）
- ❌ Meta-Harness 风格的 harness-as-optimization-target（研究项目层面，不进通用 SDK）
- ❌ 在 bscode 默认开启数据上传（隐私/治理前置，必须用户主动 opt-in）
- ❌ 引用 Tw93 文章里"6× 性能差距"这个数字（核实未通过）

---

---

## 10. Arm-f vs Bare 实验结果（2026-06-17 当日）

### 10.1 实验设计

- **目标**：诊断 v7f 38.9% 卡点是 arm-f 设计偏难还是 1.7B 模型上限
- **脚本**：`examples/benchmarks/multi-turn-scaffold-ablation.mjs`
- **模型**：`evomerge-t10-1b7-v7f:latest`（Qwen3-1.7B Q4_K_M，via Ollama）
- **参数**：`--arms bare,param-only --seeds 0,1,2`，全 30 items × 2 arms × 3 seeds = **180 cells**
- **耗时**：258 秒
- **报告**：`docs/reports/arm-f-vs-bare-2026-06-17/report.md`

### 10.2 结果

| Arm | Acc (pooled) | Wilson 95% CI | p95 wall |
|-----|-------------|----------------|----------|
| bare | 12.2% (11/90) | [7.0, 20.6] | 1.4 s |
| **param-only (arm-f)** | **41.1% (37/90)** | **[31.5, 51.4]** | 6.1 s |

**McNemar exact (param-only vs bare)**:
- arm-wins=29 | bare-wins=3 | both=8 | neither=50
- **p = 2.56 × 10⁻⁶** （高度显著）

### 10.3 解读（这反转了我 §2 部分判断）

**arm-f 不是冶炼上限，是 1.7B 的救命稻草**：
- bare 12.2% 几乎不工作 → 1.7B 自由生成 tool calls 基本写不对 schema
- arm-f Pick/Provide grammar 约束加上后 +28.9pp → grammar 把 tool name 锁住，模型只剩"填 args"
- p=2.6e-6 强信号 → 这不是"刚好"，是结构性差距

### 10.4 三个新发现

1. **arm-f 是核心资产，不要轻易放松约束**。Tw93 文章 §M5 谈 harness 改进时容易理解成"放松"，**实际反向**：arm-f 这种 grammar 约束就是最有效的 harness。下一步 harness 改进应该是**在 arm-f 内部加脚手架**（环境快照、tool retrieval、args schema 提示），不是减少约束。

2. **3 个 bare-wins 题值得单独审查**。grammar 偶尔会把模型推向错误工具——这暴露 arm-f 设计的具体瑕疵，原始数据在 `raw.json` 里能找到具体哪 3 题。

3. **`neither=50` 占 55.6%** = v7f 在这 50 题上 bare 和 arm-f 都不会。这是 **1.7B 真正的能力缺口**，**SFT 救不了**：
   - 路径 A：换更大模型（Qwen3-8B 跑同实验，看 neither 收窄多少 → 判断 capacity vs data）
   - 路径 B：harness 增强（retrieval / 多步规划 / 反思 stage）
   - 路径 C：rejection sampling（用 v7f 41% 正确轨迹反哺 SFT，提质量不提量）

### 10.5 对 §2/§3/§7 的修正

| 原建议 | 修正 |
|--------|------|
| **A1 Harness 一等概念** | ✅ 不变，但要在 docstring/example 强调 grammar 约束是 harness 的一种 |
| **A3 PRM grader** | ✅ 优先级**升高**——`tool_pick_wrong` vs `args_malformed` 这两类 PRM 信号现在有了直接客户场景 |
| **B-5 接受 38.9% 上限** | ⚠️ **修正**：不是"接受上限改 harness"，是"在 arm-f 内部加更多 harness 脚手架"。bare 12.2% 说明放手 harness 立刻退到不能用。 |
| §7 优先级 | ✅ A3 升到第 1 位，A2 第 2 位（A2 提供工具，A3 提供 reward 信号） |

### 10.6 一个直接的 G1 攻关建议给 evomerge

evomerge G1 目标 56%，v7f 当前 41.1% [31.5, 51.4]，缺 15pp。

如果聚焦在 `arm-wins=29` 类似题上（v7f 已经能做对的题型），用 rejection sampling 巩固 + 扩到相邻题型——很可能 ≥50%。

**neither=50 那 50 题不要碰**，那是 capacity 问题，扩数据没用。

---

## Memory Links

- [[workflow_engine_deliver_2026_06_17]] — WF engine + ResourcePool + WF_TRACE 抓 deferred step bug
- [[run_h_sft_diagnostic_2026_06_15]] — T10 SFT v3 -21pp shape mismatch 诊断
- [[memory_2026_deliverables_2026_06_14]] — MemoryBlockSet + LoCoMo-Refined / MemoryAgentBench
- [[strategic_plan_2026_06_12]] — evals-runner 包 + 31 stats tests + 6 reference suites
- [[feedback_agentkit_generic_foundation]] — agentkit-js 通用基础原则
- [[project_bscode]] — bscode 项目位置和形态
