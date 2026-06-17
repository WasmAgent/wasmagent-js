# arm-batch-grammar Experiment — 2026-06-17

> 跟进 arm-f vs bare 实验的"bare-wins=3 暗示 plan-then-execute 能救场"假设。新增 arm-batch-grammar（一次 LLM 调用产出完整 plan，json_schema 严格约束），跑 v7f × 30 items × 3 seeds，并和 bare/arm-f 做 paired McNemar。
>
> **结论：plan-then-execute 假设在 v7f 1.7B 上被证伪。** arm-f Pick/Provide 切片不是代价，是资产。

---

## 1. 实验设计

| 维度 | 值 |
|------|-----|
| 模型 | `evomerge-t10-1b7-v7f:latest` (Qwen3-1.7B Q4_K_M) |
| arms | bare / param-only(arm-f) / **batch-grammar(arm-g)** |
| seeds | 0, 1, 2 |
| items | 全 30 |
| 总 cells | 270 |
| 实验耗时 | ~7 分钟 |
| 报告 | `docs/reports/arm-batch-grammar-2026-06-17/{report.md, raw.json}` |

**arm-batch-grammar 设计**（`packages/evals-runner/src/suites/multi-turn-scaffold-arms.ts:armBatchGrammarSuite`）：
- 单次 LLM 调用，json_schema 强制输出 `{plan: [{name, input}, ...]}`
- `name` 是 const enum (per branch)，`input` 是各 tool 的 strict args schema
- minItems=1, maxItems=8（≥ 2× 最长 4-step 任务）
- 模型**不能**输出 `final_answer` 提前退出
- 调用返回后按顺序执行 plan，再 judge fixture state

## 2. 结果

| Arm | Acc | Wilson 95% CI | p95 wall |
|-----|-----|----------------|----------|
| bare | 6.7% (6/90) | [3.1, 13.8] | 1.4 s |
| **batch-grammar** | **14.4% (13/90)** | **[8.6, 23.2]** | 1.3 s |
| arm-f (param-only) | 38.9% (35/90) | [29.5, 49.2] | 6.2 s |

**McNemar exact (vs bare)**:
| arm | arm-wins | bare-wins | p |
|-----|----------|-----------|---|
| param-only | 29 | 0 | **3.7 × 10⁻⁹** |
| batch-grammar | 7 | 0 | 0.016 |

## 3. 关键发现

### 3.1 batch-grammar 是 arm-f 的严格子集

cross-arm 分析（per-item，3 seeds 中至少 1 通过算"会"）：
- batch 会 5 items：`fs-1step-read, fs-2step-rename, cal-1step-list, cart-2step-add-multi, fs-3step-cleanup`
- arm-f 会 14 items
- **batch 会的 5 items 中，arm-f 都会**
- **arm-f 会但 batch 不会的有 9 items**（包括所有需要 N≥3 步精确状态跟踪的题）

直白结论：**让 1.7B 一次性写完整计划，它想不出来比让它一步步走好的方案**。

### 3.2 bare 上次 12.2% 这次 6.7%——上次 5 个"真赢"是噪声

| Cell | 上次 (06-17 第一轮) | 这次 (06-17 第二轮) |
|------|---------|---------|
| bare 总 acc | 12.2% (11/90) | 6.7% (6/90) |
| bare 真用了 tool_calls | 5/90 | 0/90（全 tautology pass）|
| 上次的"bare-wins=3" | cart-3step-add-remove ×2, cal-4step-batch-create ×1 | **本次 bare 在这 3 题上 0 赢** |

**这是上次 bare-wins 分析的反转**：cart-3step-add-remove 那 2 cells 上 bare 一次性发 4 个 tool_call 赢——是模型偶发行为，不可复现。**本次 batch-grammar 在 cart-3step-add-remove 上 0/3 通过**——证明即便给 1.7B 一次性输出完整 plan 的能力，它也想不出 `add A1 → add A2 → remove A1 → checkout` 这串。

### 3.3 batch-grammar 0 个 schema/parse error

77 个失败 cells 全部 `error=null`——schema 永远合法。失败全部来自**模型计划内容错**（错的工具、错的 args、漏步骤）。

意味着 batch-grammar 的天花板就是 1.7B 模型的全局规划能力，**没有 schema 噪声可以挖了**。

## 4. 对原假设的反驳

### 4.1 假设（来自 arm-f vs bare 第一轮分析）

> "bare 在 cart-3step-add-remove 上一次性发 4 个 tool_call 赢；arm-f 输是因为 Pick/Provide 切片导致模型在 step N 忘了完整计划。让模型一次性输出 plan + grammar 约束，会把这类任务救回来。"

### 4.2 反驳（来自本实验）

1. **bare 上次"赢"是噪声**：seed 0/2 偶发对，seed 1 输；本次同 cells 全输
2. **batch-grammar 给了 1.7B 一次性写计划的能力，它在 cart-3step-add-remove 上 0/3 通过**
3. arm-f Pick/Provide **不丢全局视角**——pass 1 的 enum 选择是 tool 级决策，pass 2 的 args 决策有完整对话历史
4. **真正的杠杆是"逐步反馈" + "schema 锁住每一步"**，不是"全局规划 + schema"

## 5. 对给 evomerge 建议的影响

### 5.1 撤回的建议

**B-6 plan-token SFT** ❌ **撤回**：让模型在 SFT 数据里学 plan-then-execute 形态，理由是 batch-grammar 把这能力直接交给模型仍只 14.4%，远低于 arm-f 38.9%。即便 SFT 强化这个 shape，天花板也不会比 batch-grammar 高多少。

### 5.2 不变的建议

- **B-1** 训练-评测分布对齐审计 ✅
- **B-2** rejection sampling（用 v7f arm-f 正确轨迹反哺 SFT）✅
- **B-3** PRM 步骤诊断 ✅
- **B-4** McNemar 纪律 ✅
- **B-5** 接受当前上限 + 在 arm-f 内部加脚手架 ✅（**修改为不再提议 batch 变体**）

### 5.3 G1 56% 路径剩下两条

1. **evomerge 侧 rejection sampling**：v7f 在 arm-f 上有 35 个正确 cells（包含 6 个 tautology），剩 29 个真本事 cells。把这些轨迹反哺 v9 SFT，预期 +5-10pp。**但单靠这个不够 G1**。
2. **agentkit-js 侧改 arm-f 的脚手架**（不是 plan stage，是 retrieval / args reminder / tool 后续提示）：
   - 在 Pick stage prompt 里加"剩余子目标"提示
   - 在 Provide stage 加 args schema 文字注释
   - 这些改动只动 prompt 不动 grammar，预期 +3-7pp

**两条加起来仍然可能差 5-10pp 才到 G1**。诚实地说：**v7f 1.7B + arm-f 在当前 30 题上的天花板可能就在 45-50%，56% 需要 8B 或重设计任务集**。

### 5.4 给 evomerge 的最终判断

**`neither=50 现已变成 neither=55`**（arm-f vs bare 这次）——本次 cells 都不会的 cells 增加。这是**模型 capacity 缺口的更强证据**。

evomerge 现在面对一个清晰的选择：
- **接受 G1 56% 在 1.7B 上不可达**，转向 8B 或调整 G1 阈值
- **继续 SFT v9**，目标定为 **45-50%**，把 G1 从 56% 调到 45%（基于实验证据）
- **重设计 30 题集**，去掉 `neither=55` 那批 1.7B capacity 不够的题，让现有能力分布在新 G1 阈值下"通过"

这不是 arm 设计能解决的，是产品/客户决策。

## 6. agentkit-js 侧的去留

### 6.1 arm-batch-grammar 留还是去？

**留**。理由：
- 它是 arm-f 的有用对照（证明 Pick/Provide 切片是资产而非代价）
- 对**简单任务**（fs-1step-read 等）效率高（1 次 LLM 调用 vs arm-f 的 N 次）
- 未来对**更大模型**（8B+）可能反转——8B 的全局规划能力可能让 batch 反超 arm-f

写入 ABLATION_ARMS registry 永久保留。

### 6.2 trace serialization bug 仍然要修

arm-f / arm-batch-grammar 都没暴露 events，导致 raw.json 无法做步骤级诊断。优先级：低（独立 1h fix），不阻塞当前结论。

## 7. 一段总结

```
┌──────────────────────────────────────────────────────────────────┐
│ 假设（第一轮）：arm-f 切片 → 模型丢全局规划 → batch+grammar 救场 │
│                                                                   │
│ 实验（本轮）：v7f × batch-grammar = 14.4%，远低于 arm-f 38.9%    │
│                                                                   │
│ 反转：Pick/Provide 切片是 1.7B 的资产，不是代价。               │
│       1.7B 的真正瓶颈是全局规划能力，                            │
│       给它"一次性写计划"的能力它也想不出来。                     │
│                                                                   │
│ 结论：G1 56% 在 1.7B + 当前 30 题集上不可达。                    │
│       evomerge 应在 8B 升级 / G1 阈值下调 / 题集重设计 三选一。  │
└──────────────────────────────────────────────────────────────────┘
```
