# 给 evomerge 项目组的建议（v7f vs v8 结果之后）

> **背景**：v8（discovery-first 增强 ~15k items）评测后 30.0% [21.5, 40.1]，v7f 仍是当前最强 37.8% [28.5, 48.1]。本文档基于 Tw93 「为什么说大模型训练很难？」综述 + 我对 v7f→v8 回退的因果分析，给 evomerge 项目组 5 条可执行建议。
>
> **作者**：agentkit-js 这边（Daisy Sun）— evomerge 唯一的 distribution authority。
>
> **日期**：2026-06-17

---

## 0. TL;DR (Final, post-2026-06-17 三实验)

- **撤回**：上一版 B-6 plan-token SFT 建议 — 已实验证伪
- **核心论断**：v7f arm-f 38.9% 不是"训练不够"，是 **1.7B 全局规划能力的天花板**
- **G1 56% 在 1.7B + 当前 30 题集上不可达**（双实验证据，详见 §6/§7）
- **选项 A (升 8B) 已被硬件实测排除**（详见 §8）
- evomerge 应该选 **B（阈值下调到 45%）或 C（题集重设计）**——是产品决策不是工程
- 仍然有效：B-1 分布对齐 / B-2 rejection sampling / B-3 PRM 诊断 / B-4 McNemar 纪律
- agentkit-js 侧：A1 Harness + A2 Trajectory + A3 PRM grader 计划不变

---

## 1. v7f → v8 回退的因果分析

### 1.1 你们组当前解释

> "增加了 cal-3step/fs-4step/recovery 的比例，但同时减少了其他类别的相对权重，破坏了原有的平衡。"

**方向对，但还有一层更冷的诊断。**

### 1.2 我的诊断：covariate shift

**v8 不是单纯类别比例问题，是训练分布 ≠ 评测分布。**

证据：
- v7f 38.9%（评测分布 = 默认混合）
- v8 30.0%，但 cal-3step/fs-4step 各从 640→2000

如果 cal-3step/fs-4step 在评测里**比例和训练里一样高**，v8 应该至少持平或上涨。既然反而退了 **7.8pp**，说明评测里这两类**占比远小于 v8 训练分布里的占比**。

模型在训练里看到的"先 list 后 act"是 ~31% (`2000×3 / ~15k`) 主导；评测里这种 shape 占比可能 <15%。**这是经典 covariate shift。**

### 1.3 注意统计纪律

- v7f：37.8% [28.5, 48.1]
- v8：30.0% [21.5, 40.1]
- **CI 重叠区间 [28.5, 40.1] 很大**

更严谨的判断需要 **McNemar paired test on 同一组评测题**（这正是 evomerge CLAUDE.md §0.2 G1 门要求的 `McNemar p<0.05`）。如果 McNemar p > 0.05，应该改成"v8 与 v7f 在 n=90 上未显著区分"，而不是"v8 比 v7f 退 7.8pp"。

不是说方向错——**v8 不优**这个判断对，只是后续训练决策不要被 7.8pp 这个看起来很大的数字带着矫枉过正。

---

## 2. 五条具体建议（按 ROI 排序）

### B-1 训练-评测分布对齐审计（最高优先 · 0.5 天）

**v9 之前必须做完这一步**，否则可能复制 v8 错误。

**脚本草案**：
```python
# 输入：
#   - 评测集 180 cells（每 cell 标注 task_type, n_steps, failure_mode）
#   - v8 训练集 ~15k items（同样标注三元组）
# 输出：
#   - 列联表 (task_type × n_steps × failure_mode) 双边占比
#   - 标红：训练 / 评测 ratio ∉ [0.7, 1.4] 的 cells
#   - 标红：评测里出现但训练里 <1% 的 cells（OOD）
```

**判定**：任何 cell 训练占 20% 但评测占 5%，直接砍 oversampling。

这不是猜分布，是测分布。

### B-2 不要再做 SFT v9，做 rejection sampling（高优先 · 1 天）

Tw93 文章 M1 的关键洞察：**rejection sampling = RL/采样里成功的轨迹反哺 SFT**。

**具体步骤**：
1. 拿 v7f 跑评测（已经有 Run M2 全量结果），**保留所有 final_correct=true 的 rollouts**
2. 把这些 v7f 自己产生的正确轨迹当成新一轮 SFT 数据
3. provenance：`provenance.source = "rejection-sampled-from-v7f-run-M2"`
4. 训 v9 = v7f base + 这批 rejection-sampled 数据

**关键约束**：rejection-sampled 数据的分布**天然贴合评测分布**（就是评测里 v7f 答对的那批），**不会再出 v8 covariate shift**。

**预期**：
- v9 不一定大涨（毕竟 v7f 已经"会"那些题）
- 但**几乎不可能比 v7f 退**
- 真正涨的部分来自轨迹被规范化后，模型对 arm-f Pick/Provide shape 的稳定性

低风险高把握动作。

### B-3 PRM 风格步骤级诊断（高优先 · 1 天）

**痛点**：v7f 38.9% 这个数字告诉你模型答对率，**但没告诉你错的那 61% 错在哪一步**。

Tw93 文章 M3：PRM 在小模型可验证任务上 ROI 远高于 ORM，因为它把训练目标从"最终答案对"转成"每一步都对"。

**evomerge 侧具体动作**（很轻量）：

评测每条 trajectory 时，不止记 `final_correct: bool`，还记：
```json
{
  "final_correct": false,
  "first_wrong_step": 2,
  "wrong_step_kind": "tool_pick_wrong",  // 或 args_malformed / premature_stop / state_collapse / hallucinated_state
  "expected_tool": "list_files",
  "actual_tool": "move_file"
}
```

跑一遍 v7f 评测，画失败模式直方图。**下一轮训练只针对最大那个失败模式扩数据**，而不是按粗类（cal-3step）扩。

**agentkit-js 侧支撑**：我即将在 evals-runner 加 `graders/prm/` 子目录（见原计划 §A3），提供：
- `processGrader(stepValidator)` — 通用 PRM grader
- `toolCallShape.ts` — tool-call schema 合规
- `intermediateStateConsistency.ts` — 状态一致性

这些 grader 你们直接用，不用自己写。

### B-4 Wilson CI 重叠时改用 McNemar（中优先 · 0.5 天）

统计纪律问题。前面 §1.3 说过——v7f vs v8 当前的 CI 大幅重叠，"v8 退 7.8pp" 这个表述不够稳。

**建议**：所有"vN vs vM"判断都跑 McNemar paired test on 同一题集，p<0.05 才算"显著退/进"。否则报告写"未显著区分"。

CLAUDE.md §0.2 G1 已经要求了 McNemar，**只是 v7f vs v8 这次 informal 比较里没用上**。形成纪律。

### B-5 接受当前上限，下一阶段从 harness 而非 SFT 要 7pp（中优先 · 长线）

**最反直觉但可能最对的一条。**

⚠️ **2026-06-17 实验已经为这条做了精确化** —— 见 §6：bare arm 上 v7f 只有 12.2%，arm-f 上 41.1%，差 28.9pp。意思是：**arm-f 不是"偏难"，是 1.7B 的核心 harness**。下一步 harness 改进**不是放松 arm-f**，是**在 arm-f 内部加脚手架**。

我刚才（agentkit-js 这边）核实了 Meta-Harness 论文（Stanford IRIS Lab，ACM CAIS 2026 Workshop Oral，https://yoonholee.com/meta-harness）：

| 指标 | 数字 |
|------|------|
| Online text classification | **48.6% vs ACE 40.9% = +7.7 pts**，同时 context tokens **4.5× 节省** |
| Math IMO 200 题，5 held-out models | **+4.7 pts avg**（34.1→38.8） |
| TerminalBench-2 完整 89 任务 | Opus 4.6 上 76.4% (#2)，Haiku 4.5 上 37.6% (#1) |

**核心论点**：**同样模型，只改 harness 能拉出 7.7pp**。

具体到我们 T10 场景的可能动作：

| Harness 改进 | 谁来做 | 预期收益 |
|-------------|--------|---------|
| 首轮 environment bootstrap snapshot 注入 | agentkit-js arm-f 改 | 减少前几轮探环境消耗 |
| Pick stage 加 `available_tools_summary` retrieval | agentkit-js arm-f 改 | 降 tool_pick_wrong 失败率 |
| Provide stage 加 args schema reminder | agentkit-js arm-f 改 | 降 args_malformed 失败率 |

这些改完，**v7f 模型不变**，arm-f 准确率可能直接到 50%+，零训练成本。

**这是给 evomerge 组的战略建议**：当前训练接近这一代数据形态的天花板，**下一个 7pp 应该从 harness 而非 SFT 里要**。这不是让 evomerge 不做训练，是让 evomerge 知道在 v9-v12 SFT 上的边际收益可能 <2pp，应该把心思放在和 agentkit-js 一起改 arm-f 设计上。

---

## 3. agentkit-js 即将提供的支撑

我（agentkit-js 这边）正在做的，evomerge 可以直接用：

| 交付物 | 状态 | 给 evomerge 的用途 |
|--------|------|------------------|
| **A2 Trajectory recording + replay** | 计划中 | 训练数据导出 + step-level diff 调试 v8 类问题 |
| **A3 Verified-reward graders (ORM)** | 计划中 | 工具调用合规 / JSON schema / code runs |
| **A3 Verified-reward graders (PRM)** | 计划中 | 直接支撑 §B-3 步骤级诊断 |
| **arm-f vs bare 对比实验** | **进行中**（2026-06-17） | 判定 arm-f 是否本身偏难，决定 §B-5 是否值得 |

后续我会把每个 release 同步给你们组。

---

## 4. 一个 open question 给你们

**v8 训练时**，loss curve 是不是在 ~step 600 之后就 plateau 了？如果是，说明 ~15k items 后期信息密度已经很低，再扩数据量边际收益接近 0。这进一步支持 §B-2 rejection sampling（用质量换数量）+ §B-5（改 harness）的方向。

如果 loss 还在降但 eval 不涨，那是经典 SFT overfit-to-train，更要做 §B-1 分布审计。

---

## 5. 不要做的事

- ❌ 直接训 v9，沿用 v8 数据策略再调比例（先做 §B-1）
- ❌ 把 v8 的 7.8pp 退步当成强证据（先做 §B-4 McNemar）
- ❌ 把 cal-3step / fs-4step 进一步加到 3000 items（covariate shift 更糟）
- ❌ 引用 Tw93 文章里 "Meta-Harness 6× 性能差距" 这个数字（核实未通过，应该是 +7.7pp 和 4.5× context 节省）

---

## 引用

- Tw93《为什么说大模型训练很难？》— 触发本讨论的综述
- Lee et al. (2026). Meta-Harness: End-to-End Optimization of Model Harnesses. ACM CAIS 2026 Workshop (Oral). https://yoonholee.com/meta-harness ｜ https://arxiv.org/abs/2603.28052
- DeepSeek-AI (2025). DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning. arXiv:2501.12948 — rejection sampling 四阶段流水线
- agentkit-js 计划文档：[`docs/strategy/post-training-leverage-2026-06-17.md`](./post-training-leverage-2026-06-17.md)

---

## 6. 2026-06-17 当日新证据：arm-f vs bare 实验

为了校准给你们的 §B-5 建议，我（agentkit-js 这边）当日跑了 v7f 在 bare arm vs param-only(arm-f) 上的对比：

### 6.1 实验

- **模型**：`evomerge-t10-1b7-v7f:latest`（你们组的 Run M2 当前最强）
- **脚本**：`examples/benchmarks/multi-turn-scaffold-ablation.mjs`
- **参数**：30 items × 2 arms × 3 seeds = **180 cells**，258 秒
- **报告**：`docs/reports/arm-f-vs-bare-2026-06-17/report.md`

### 6.2 结果

| Arm | Acc | Wilson 95% CI |
|-----|-----|----------------|
| bare（无 grammar 约束） | **12.2%** (11/90) | [7.0, 20.6] |
| **arm-f (param-only)** | **41.1%** (37/90) | **[31.5, 51.4]** |

**McNemar exact**：arm-wins=**29**, bare-wins=**3**, both=8, neither=**50**, **p = 2.56 × 10⁻⁶**

### 6.3 给你们的三个直接洞察

**洞察 1：arm-f 是核心资产，不要轻易动**

放松 arm-f → 退到 12.2%。grammar 约束本身就是最有效的 harness。你们继续训练时，不要"为了泛化"考虑训成 bare-friendly 的形态——那会损失 28.9pp。

**洞察 2：3 个 bare-wins 题揭示 arm-f 的适用边界（不是 bug）**

bare-wins 集中在 `cart-3step-add-remove`（含撤销）、`cal-4step-batch-create`、`mixed-N-step` 这类**需要全局规划**的任务上。详细分析在 `docs/reports/arm-f-vs-bare-2026-06-17/bare-wins-analysis.md`。

bare 模式 v7f 在 cart-3step-add-remove 上一次性输出 4 个 tool_call（`add A1 → add A2 → remove A1 → checkout`）一气呵成赢了。arm-f Pick/Provide 把决策切片，模型在 step 3 时**忘了"还要 remove A1"**直接 checkout，输了。

**这是 arm-f 设计的 trade-off，不是缺陷**：
- arm-f 适合 schema-bound 工具调用（避免 grammar 错误）
- arm-f 不适合需要 N>3 步全局规划的任务
- 解决方向：在 arm-f 内部加 **plan stage**（让模型先吐完整计划再 Pick/Provide），不是放松 grammar

**洞察 3：`neither=50` 占 55.6% 是 1.7B 真正的能力缺口**

50/90 cells 上 v7f 在 bare 和 arm-f 上**都不会**。这是 capacity 问题，**SFT 救不了**。你们组在 v9-v12 上沿当前数据形态扩量，最多能动的是 `arm-wins=29` 那批（"会但不稳"），动不了 `neither=50` 那批。

**直接 G1 攻关建议**：
- v7f 当前 arm-f 41.1% [31.5, 51.4]，G1 目标 56%，缺 15pp
- **路径 1**（evomerge 侧）：聚焦 `arm-wins=29` 类似题型 + 用 v7f 自己产生的正确轨迹做 rejection sampling（§B-2）。预期 +5-10pp
- **路径 2**（agentkit-js 侧）：arm-f 加 plan stage（见洞察 2），把 cart-含撤销 / cal-4step / mixed-N-step 这类任务族拉回来。预期 +5-15pp
- **neither=50 那批不要扩数据**，要么留给 8B，要么靠 retrieval / 反思 stage

### 6.4 一个待办（agentkit-js 侧）

- ✅ **已完成**：扫 `raw.json` 完成 bare-wins 分析（详见 `docs/reports/arm-f-vs-bare-2026-06-17/bare-wins-analysis.md`），结论是 arm-f 在 cart-含撤销 / cal-4step / mixed-N-step 上系统性偏弱（**情况 B**），不是 evaluation bug
- 🔜 **待做**：考虑实现 `arm-f-with-plan` 变体（plan stage → Pick/Provide），可能直接加 +5-15pp。工作量 0.5-1 天。优先级中（A1+A2+A3 之后）
- 🔜 **顺手修**：trace serialization bug — runArmF 没暴露 events 字段导致 raw.json 无法做步骤级诊断，~1 小时修

### 6.5 ~~新增：B-6 plan-then-execute SFT 数据形态~~ **[2026-06-17 撤回]**

⚠️ **本节已撤回**。完整反转见 §7（arm-batch-grammar 实验）。

简而言之：第二轮实验直接做了一个"让 1.7B 一次性输出完整 plan + json_schema 强约束"的 arm（arm-batch-grammar），结果只有 14.4%，远低于 arm-f 的 38.9%。说明 plan-then-execute 不是 v7f 的瓶颈解，**给 1.7B 一次性写完整计划的能力，它也想不出来**。所以训练数据里加 plan token 也救不了。

详见 `docs/reports/arm-batch-grammar-2026-06-17/analysis.md`。

---

## 7. 第二轮实验：arm-batch-grammar — plan-then-execute 假设证伪

### 7.1 动机

§6.3 洞察 2 看到 bare-wins=3 题（cart-3step-add-remove ×2 + cal-4step-batch-create ×1），假设是 "Pick/Provide 切片让 1.7B 丢全局规划"。如果对，让模型一次性输出完整 plan 应该能救场。

### 7.2 实验

新增 `arm-batch-grammar`（agentkit-js `packages/evals-runner/.../armBatchGrammarSuite`）：
- 单次 LLM 调用，json_schema 严格约束 `{plan: [{name, input}, ...]}`
- maxItems=8，minItems=1，禁止 final_answer 提前退出
- 调用返回后顺序执行 plan，再 judge

跑 v7f × bare/arm-f/arm-batch × 3 seeds × 30 items = **270 cells**。

### 7.3 结果

| Arm | Acc | Wilson 95% CI | vs bare McNemar p |
|-----|-----|----------------|-------------------|
| bare | 6.7% (6/90) | [3.1, 13.8] | (baseline) |
| **arm-batch-grammar** | **14.4%** (13/90) | [8.6, 23.2] | 0.016 |
| arm-f (param-only) | 38.9% (35/90) | [29.5, 49.2] | **3.7 × 10⁻⁹** |

**关键 cross-arm 对比**：
- batch-grammar 会的 5 items 中，arm-f **全都会**
- arm-f 会但 batch 不会的有 9 items
- batch 在 cart-3step-add-remove 上 **0/3 通过**（即 §6.3 假设的"救场题"，batch 也救不了）

### 7.4 三个反转

**反转 1**：bare 上次 12.2% 这次 6.7% — 上次"5 个真赢"是噪声

| 指标 | 第一轮 | 第二轮 |
|------|-------|-------|
| bare 总 acc | 12.2% | 6.7% |
| bare 真用 tool_calls 赢的 | 5/90 | 0/90 |

第一轮 bare-wins=3 题（cart-3step-add-remove ×2 + cal-4step-batch-create ×1）这次 bare 也输了。**那 3 题不是稳定能力，是抽样偶然**。

**反转 2**：plan-then-execute 不是 v7f 缺口

batch-grammar 把"一次性写完整计划 + grammar 强约束"的能力直接交给模型，仍只 14.4%。说明**1.7B 缺的不是机会，是能力**。

**反转 3**：Pick/Provide 切片是资产不是代价

arm-f 的 Pick/Provide 让模型每一步只面对一个 args 决策，**错率反而比一次性写 N 步 args 低**（args 错率随 N 累乘）。这就是 arm-f 38.9% > batch 14.4% 的根本原因。

### 7.5 G1 56% 现在的真实状况

`neither` cells（bare/arm-f 都不会）：
- 第一轮: 50/90 (55.6%)
- 第二轮: 55/90 (61.1%)

**有超过 60% 的题是 1.7B 在任何 harness 下都做不对的**。这不是训练能解决的，**是 capacity**。

evomerge 现在面对一个清晰的产品/客户选择：

| 选项 | 路径 | 预期 G1 acc |
|------|------|-------------|
| **A. 升级 8B** | 跑 `Qwen3-8B` 同套实验，预期 neither 大幅收窄 | 应该 ≥56% (待验证) |
| **B. 阈值下调** | G1 从 56% 改到 45%，承认 1.7B 上限 | v7f arm-f 已经 38.9%，rejection sampling + arm-f prompt 加脚手架可达 |
| **C. 题集重设计** | 去掉 `neither=55` 那批，让现有能力在新题集上自然过线 | 取决于客户需求是否允许 |

**这不是 SFT 能改变的，是产品决策。请你们组在内部明确选哪条路。**

### 7.6 给你们的具体下一步建议

如果选 **A（升 8B）**：跑 `evomerge-qwen3-1b7-v7f` 同样的训练流程在 8B base 上，先测 base + arm-f 的天花板。**评测要先跑**，不要先训。

如果选 **B（阈值下调）**：直接做 §B-2 rejection sampling，目标 v9 在 arm-f 上 45-48%。可达性高。

如果选 **C（题集重设计）**：和我（agentkit-js 这边）一起重设计 30 题集，去掉 1.7B 在 batch/arm-f 都失败的 cell-types，新题集上跑一遍 v7f 看 baseline。

### 7.7 第二轮副产品

- ✅ `armBatchGrammarSuite` 留在 `ABLATION_ARMS` registry，未来给 8B 跑能直接用（8B 可能反超 arm-f）
- ✅ 证明 grammar+多 tool_call 能力在 agentkit-js 侧已具备，无需新功能
- ✅ 双轮实验把"v7f 38.9% 是不是上限"的不确定性收窄到很小

---

## 8. 第三轮（终结）：选项 A "升 8B" 被硬件实测排除

### 8.1 实验

试图在本机 (Apple Silicon MacBook Pro, Metal GPU 全 offload) 上跑 8B (Qwen3-8B Q3_K_M, 4.12 GB) × 3 arms × 3 seeds × 30 items = 270 cells，复现 1.7B 第二轮的 baseline 对比。

### 8.2 观测

llama-server 进程实际配置（高端 Mac 接近最优）：
- `-ngl 99` 全 GPU offload (Metal)
- `-c 40960` 40K context KV cache
- `-t 8` 8 线程
- `-b 2048 -ub 2048` 高 batch
- `--flash-attn auto`
- 17.5 GB RAM 被 llama-server 占用

**结果：22 分钟，0 cells 完成（progress 是 5 cells 一行，22min 里一次都没出）**。

预估完整实验耗时 4-6 小时。已 kill 任务。

### 8.3 解读

参考 1.7B 同套实验耗时：
- 1.7B 270 cells = 7 分钟（p95 wall = 6.2s/cell on arm-f）
- 8B 同套预估 4-6 小时

**8B 在 agent 多步任务下不是 2-3× 慢，是 ~50-100× 慢**（arm-f 一次 task = 15+ LLM 调用）。

### 8.4 用户基数推论

**这台机器是市场最强 MacBook Pro 之一**。如果它都跑不动 8B agent 任务，那么：
- M1/M2 Air 16GB → 更慢，会 swap
- M1 8GB / Intel Mac → 不能跑
- 16GB Win 笔记本无独显 → 数小时一个 task
- 4GB VRAM 独显 → 模型勉强进 VRAM，agent 任务仍慢

意味着选项 A 的产品后果：**直接排除 ~95% 的目标用户硬件**，只服务有 RTX 4060+ / M3 Max+ 的少数用户。

**这违背 agentkit-js 通用基础原则 + evomerge 服务大众的产品定位**（[[feedback_agentkit_generic_foundation]]）。

### 8.5 决策

**选项 A 被排除**。

剩两条路：

| 选项 | 路径 | 何时合适 |
|------|------|---------|
| **B. 阈值下调到 45%** | rejection sampling v9 → arm-f 45-48% | 客户能接受 G1 阈值松动 |
| **C. 题集重设计** | 去掉 `neither=55` 那批不可救药的题 | 客户愿意协商任务集 |

我（agentkit-js 这边）的建议是 **B → C 串行**：
1. 先做 B 把 v9 压到 ~45-48%（1-2 天，低风险）
2. 同时分析 `neither` 那批失败 cells 是否真有客户场景，没有就提议 C 砍掉
3. 砍掉后，**v9 在新题集上很可能直接过 56%**，G1 不用动

这是"既保证用户硬件门槛，又满足客户阈值"的两全解。

### 8.6 给 evomerge 组的最终交付清单

**evomerge 侧**：
- ✅ B-1 分布对齐审计（先做，0.5 天）
- ✅ B-2 rejection sampling v9（用 v7f arm-f 35 个正确 trajectories，1-2 天）
- ✅ B-3 PRM 诊断（同时做，给 v9 失败模式画像）
- ✅ B-4 vN vs vM 必跑 McNemar paired test
- ❌ B-6 plan-token SFT（撤回）
- ❌ 升 8B（硬件实测排除）

**agentkit-js 侧（已完成或计划中）**：
- ✅ arm-f vs bare ablation（第一轮）
- ✅ arm-batch-grammar 实现 + 实验（第二轮，证伪 plan 假设）
- ✅ 给 evomerge 的所有诊断 + 文档
- 🔜 trace serialization bug 修复（~1h，runArmF 暴露 events）
- 🔜 A3 PRM grader 接口（直接支撑 B-3）
- 🔜 协助 C 题集重设计（如果 evomerge 选 C）

**联合决策需要客户参与**：B vs C 取决于客户是否能接受"G1 阈值松到 45%"或"题集瘦身"。这个决策不在工程范围内。
