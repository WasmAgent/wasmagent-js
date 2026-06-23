# Bare-wins Analysis — arm-f vs bare 2026-06-17

> 分析 arm-f vs bare ablation 中 3 个 "bare 赢、arm-f 输" 的 cells，验证 arm-f 是否有设计瑕疵。
>
> 输入：`docs/reports/arm-f-vs-bare-2026-06-17/raw.json`（180 cells）
>
> 结论：**情况 B（系统性偏弱）**，不是 A（噪声）也不是 C（评测 bug）。

---

## 1. 三个 bare-wins cells

| Cell | bare in/out/ms | arm-f in/out/ms | bare 行为 | arm-f 行为 |
|------|---------------|------------------|----------|----------|
| cart-3step-add-remove::seed=0 | 2357/201/894 ✓ | **8800/221/4257** ✗ | 1 步发 4 个 tool_call 一气呵成 | 跑了 ~7-10 步 Pick/Provide 仍没赢 |
| cart-3step-add-remove::seed=2 | 2344/185/896 ✓ | **14426/344/6047** ✗ | 同上 | 跑了 ~12-15 步仍没赢 |
| cal-4step-batch-create::seed=2 | 2809/337/1368 ✓ | 2219/150/1800 ✗ | 1 步批量发多个 add_event | 较快放弃 |

**两件事清楚**：
1. `cart-3step-add-remove` 在 2 个 seed 上都 bare 赢、arm-f 输 — **不是噪声**
2. arm-f 在这 3 cells 上 token 用量都不少（特别 cart 那两个 input >8K, >14K）— 跑了多步 loop，**不是放弃，是真的没赢**

---

## 2. 失败模式诊断

### 2.1 evaluation/grader 没问题（排除情况 C）

- `error count = 0/53` arm-f 失败里全部 `lastError = null` — 不是 grammar parse 错
- judge() 看 fixture state 是 mutable 真实状态 — 不是恒真
- raw.json 的 `events=3` stub 是 trace 序列化没暴露 events 字段（runArmF 没返回 `events: []`），是 trace 显示 bug，**不影响 pass/fail 判定**

### 2.2 真正的失败模式（情况 B 系统性偏弱）

**arm-f 在三类任务上系统性偏弱**：

| 任务族 | arm-f 3/3 失败的 items |
|--------|-----------------------|
| `cart-3step-add-remove` | 含撤销操作（add 后 remove）|
| `cal-4step-batch-create` / `cal-4step-cleanup` / `cal-3step-conflict-check` | 多步 calendar，需要 inspect → mutate |
| `mixed-3step-export` / `mixed-4step-summary` / `mixed-3step-rename-and-create` | 跨 fixture 整合 |
| `fs-4step-organise` / `fs-4step-merge` | 4-step 文件批量操作 |

**根因假设**（基于行为对比）：

bare 一次性输出包含 4 个 tool_call 的完整计划：
```
add_to_cart(A1, 2)
add_to_cart(A2, 1)
remove_from_cart(A1)
checkout
```

arm-f Pick/Provide 把决策切片，**模型每一步只能看一个动作的局部信息**：
- step 1: pick "add_to_cart" → fill (A1, 2) ✓
- step 2: pick "add_to_cart" → fill (A2, 1) ✓
- step 3: pick ??? — **此时模型已经忘了"还要 remove A1"** → 直接 checkout / final_answer
- 结果：cart 终态是 [A1×2, A2×1] checked-out，judge 期望 [A2×1] checked-out → fail

这不是 evaluation bug，是 **Pick/Provide 把多步规划压成局部决策的代价**。

---

## 3. 对原结论的影响

### 3.1 不变的部分

- ✅ arm-f vs bare = **41.1% vs 12.2%, +28.9pp, p=2.6e-6** — 数字真实
- ✅ arm-f 在多数任务上是 1.7B 的核心 harness
- ✅ neither=50 (55.6%) 是 1.7B capacity 缺口的判断仍然成立

### 3.2 需要修正的部分

| 原表述 | 修正 |
|--------|------|
| "3 个 bare-wins 题暴露 arm-f 设计瑕疵" | **改为**: arm-f 在 **含撤销/多步规划/跨 fixture** 类任务上系统性偏弱，因为 Pick/Provide 把全局规划压成局部决策 |
| "100% arm-f 失败都是 0-tool-call DONE" | **撤回**: events=3 是 trace 序列化没暴露 runArmF 内部 steps，不是模型行为；**模型实际跑了 Pick/Provide 多步 loop**（input tokens 中位数 fail=2565, pass=1266 证明）|

### 3.3 给 evomerge 的具体建议（升级）

原 §B-3 PRM 诊断要求记录 `first_wrong_step` 和 `wrong_step_kind`。基于这次发现，**`wrong_step_kind` 枚举要加一个**：

- `lost_global_plan` — 模型在 Pick stage 选错下一步，**不是因为不会，而是因为忘了整个计划**

针对这类失败，PRM 应该在每个 Pick step 之前检查"剩余需要做的事"是否还在 working memory 里。如果不在，触发 reminder。

---

## 4. 对 WasmAgent arm-f 设计的反思

arm-f 不需要"修 bug"，但有一个**改进方向**值得记下：

### 4.1 提议（不立即实施，记录在路线图）

**`arm-f-with-plan` 变体**：在 step 1 之前增加一个**plan stage**，让模型先输出整个 tool_call 序列（不带具体 args），然后 Pick/Provide 阶段按这个序列执行：

```
plan stage (1 LLM call):
  → "Given task: X, output a list of tool_names you'll need."
  → strict grammar = array of tool_name enum
  → produces e.g. ["add_to_cart", "add_to_cart", "remove_from_cart", "checkout"]

execute stage (per planned tool):
  → for each tool in plan:
      pick stage skipped (plan already says which tool)
      provide stage: fill args
      execute
```

**这是 Tw93 文章 §M5 "harness 是一等公民" 的具体应用**，也对应 Meta-Harness 论文 §Demo 里看到的 "environment bootstrap → plan → execute" 演化路径。

### 4.2 不立即做的理由

- A1+A2+A3 优先（建立通用基础设施再做特定 arm 变体）
- evomerge G1 攻关时机更紧（B-2 rejection sampling 的工作量更小、收益更确定）
- `arm-f-with-plan` 需要重新跑全套 ablation 验证，工作量 0.5-1 天

记入 `docs/strategy/post-training-leverage-2026-06-17.md` 路线图。

---

## 5. 给 evomerge 的最终建议（基于本次完整分析）

**v9 训练数据策略**（推荐）：

1. **B-1 分布对齐审计** — 不变
2. **B-2 rejection sampling** — 不变，且明确：rejection-sampled 数据应该**优先包含 plan-then-execute 形态的多步示范**，让模型学会 "step 1 列计划 → step 2-N 按计划走"
3. **B-3 PRM 诊断** — 加 `lost_global_plan` 失败模式
4. **新增 B-6**：考虑在 SFT 数据里**显式加入 plan token**（在 user task 后面让 assistant 先吐一段计划，再走 tool_calls）。这是 OpenAI o1 / DeepSeek-R1 cold-start SFT 的一种轻量化做法。

**G1 56% 是否还可达**：

- v7f 当前 41.1%
- 如果 §4.1 `arm-f-with-plan` 把 cart-3step-add-remove / cal-4step-batch / mixed-N-step 这些任务族拉回来（约 40 cells），**理论上可加 ~15pp**
- 也就是说 G1 56% **可达**，但要靠 harness 改进 + rejection sampling 双管齐下，**不是单靠 SFT 扩量**

---

## Appendix: trace serialization bug

**Bug**: `runArmF` 在 `packages/evals-runner/src/suites/multi-turn-scaffold-arms.ts` 没返回 `events: TraceEvent[]`，导致 `runner.js` line 305 fallback 合成 3 个 stub events。

**影响**：所有 arm-f cells 的 `trace.events` 都是 3 个 stub，**只能用于 final_answer 文本**，不能用于步骤级诊断。

**应该修**（low effort）：在 runArmF 里收集 `tool_call` / `tool_result` events，返回到 `RunItemResult.events`。修完后下次 ablation 跑出来的 raw.json 才能支持 PRM 步骤级分析。

工作量：~1 小时。建议跟 A2 Trajectory recording 一起做。
