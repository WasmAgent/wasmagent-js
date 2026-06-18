# Loop Engineering — agentkit-js 对照表

> 这份文档把 Addy Osmani《Loop Engineering》的 6 组件 + 衍生需求逐项映射
> 到 agentkit-js 现有原语。目的是让从 Loop Engineering 这个概念走过来的
> 用户**找到 agentkit 在哪一层做了什么**，以及**哪些刻意没做**（不是没做完）。
>
> 来源：
>   - Addy Osmani《Loop Engineering》（addyosmani.com，2026-06）
>   - 茜布《循环工程：AI 编程进入"控制系统时代"》（知乎，2026-06）
>   - EurekAgent (arXiv:2606.13662, 2026-06-11)
>   - Reward Hacking 系列论文（详见 `docs/guides/reward-hacking.md`）

## TL;DR — 一张表

| Loop Engineering 组件 | agentkit-js 对应 | 状态 |
|---|---|---|
| **Automations**（自动触发） | 不在范围 — 留给上层 (cron / Cloudflare Cron Triggers / GitHub Actions) | ⚪ 刻意不做 |
| **Worktrees**（隔离工作树） | `BranchableWorkspace` (F3) + `isolation: "worktree"` 选项 | ✅ 已有 |
| **Skills**（项目知识文档） | `Skill` + `SKILL.md` + `agentsMd` (`packages/core/src/skills/`) | ✅ 已有 |
| **Plugins / Connectors** | `@wasmagent/mcp-server` + `tools-rag` + tool registry | ✅ 已有 |
| **Sub-agents**（Maker-Checker） | `Subagent` + `asTool()` + `AgentTeam` + `Handoff` | ✅ 已有 |
| **Memory / State** | `Checkpointer` + `StructuredMemory` + `ObservationalMemory` + `MemoryBlockSet` | ✅ 已有 |
| **`/goal` 声明式原语** | `GoalAgent` (2026-06-15) | ✅ 已有 |
| **L1 / L2 / L3 分层路由** | `FallbackModel` + `localFirst` preset（按 reachability 路由，不是 frequency 分层） | ⚠️ 部分 |
| **Verifier sub-agent** | `judgeScorer` + `SelfConsistencyRunner`，用户自己组合（不是 first-class 角色） | ⚠️ 部分 |
| **Reward-Hacking 防御 — IPT** | `iptShortcutRate` + `iptClassify` (2026-06-15) | ✅ 已有 |
| **Reward-Hacking 防御 — 其他**（捷径方向探针 / inoculation prompting / process supervision） | 不在范围 — 训练侧问题，留给 evomerge 那条线 | ⚪ 刻意不做 |
| **执行安全 — 沙箱** | `WasmKernel`（QuickJS / Pyodide / Wasmtime）+ `RemoteSandboxKernel` (E2B / Cloudflare Sandbox) | ✅ 已有 |
| **执行安全 — Capability 限制** | `CapabilityManifest` (allowedHosts / Read / Write / env / cpuMs / memoryLimit) | ✅ 已有 |
| **执行安全 — Skill 签名校验** | 不在范围（短期内会加） | ⏳ 计划 |
| **执行安全 — 审计日志脱机持久化** | `EventLog` + `Checkpointer` 持久化到 KV（应用决定 store） | ⚠️ 部分 |
| **预算工程 — Token 预算** | `TokenBudget` + `costBudget` (StopCondition) + `GoalAgent.tokenBudget` | ✅ 已有 |
| **预算工程 — 步数上限** | `stepCountIs` + 每个 agent 的 `maxSteps` | ✅ 已有 |
| **预算工程 — 时间预算** | `EnhancementPolicy.budget.maxDurationMs` (ToolCallingAgent) | ✅ 已有 |
| **HITL —降级接管** | `Checkpointer.respond()` + `needsApproval` 工具 | ✅ 已有 |
| **HITL — 状态打包推送 Slack/Linear** | 不在范围 — 留给上层应用 | ⚪ 刻意不做 |

---

## 详解：刻意不做的 vs 部分做的 vs 完整做的

### 刻意不做（agentkit 不该做这些）

#### 1. Automations / 自动触发器

`cron` / Cloudflare Cron Triggers / GitHub Actions / `setInterval` —— 这些都是
**部署时的事**，不是 SDK 的事。如果 agentkit 加进去，就把"库"变成"框架"，
违反 [[feedback_agentkit_generic_foundation]] 的"通用基础"原则。

**用户怎么做**：上层应用自己 schedule，agentkit 提供运行时（agent + kernel +
checkpointer），上层选时机调用。

#### 2. HITL 状态推送到 Slack / Linear

这是产品层逻辑（要 Slack token、Linear API key、UI 模板），不该污染 SDK。

**用户怎么做**：在 `Checkpointer` 触发 `await_human_input` 事件时，应用层捕获
事件 → 推 Slack / Linear，应用层等用户回复 → 调 `checkpointer.respond()`。

#### 3. Reward-Hacking 防御里的训练侧手段

捷径方向探针、inoculation prompting、process-based supervision —— 这些都需要
RL 训练流程改造（GRPO advantage modification、表征工程提取 cheat direction
等）。SDK 不做训练。

**用户怎么做**：把训练交给 `evomerge` 这条线（或任何 SFT 流水线）。agentkit
提供：(a) IPT 在推理侧的 shortcut 探测，(b) 一致的 verifier 接口让 SFT
管线知道 "我们要保护什么不被 hack"。

---

### 部分做（够用但有改进空间）

#### 4. L1 / L2 / L3 分层路由

文档建议按"频次百分比"做硬分层：L1（60%、小模型 / 确定性工具）、L2（30%、
中型模型）、L3（10%、推理大模型）。

agentkit 当前有 `FallbackModel`（model A 失败 fallback model B）+ `localFirst`
preset（先本地、本地失败上 API）。**按 reachability 路由，不是按 task type**。

**为什么暂不做硬分层**：先用 `FallbackModel` + 用户自己组合 GoalAgent (L3) →
ToolCallingAgent (L2) → 直接 verify() 调本地工具或小模型 (L1)。这把"分层"
作为应用模式而不是 SDK 抽象 —— 看用户实际用法再决定要不要起一个
`TieredRouter` API。

#### 5. Verifier sub-agent 角色

文档强调"Maker-Checker 分离"。agentkit 有 `judgeScorer` 和 `Subagent`，可以
组合出 verifier。但**没有 first-class "Verifier" 类**专门处理这个角色。

**为什么暂不做**：当前 `judgeScorer` 已经覆盖单步评估，`SelfConsistencyRunner`
覆盖多 rollout 投票。一个"Verifier sub-agent"类型在当前用例里只是 alias。
等出现 ≥3 个真实 verifier-only 用例时再起类型。

#### 6. 审计日志脱机持久化

agentkit 有 `EventLog` 收集 agent 事件，`Checkpointer` 可以持久化。但**没有
强制 off-host audit trail** —— 应用可以选择把 EventLog 推到任何地方，但 SDK
不强制。

**为什么暂不做**：strict off-host audit 是产品决定（对监管严的客户重要，对
本地开发不重要）。SDK 提供 hooks，应用决定接哪里。

---

### 完整做（生产可用）

#### 7. Worktrees / 隔离

`BranchableWorkspace` (F3) 提供基于 git worktree 的并发 agent 隔离。每个
agent 用独立分支，主分支不被并发污染。`isolation: "worktree"` 选项让
agentkit 自动管 worktree 生命周期。

**对应文档**：第 49 行"Claude Code 的 `--worktree` 标志、`isolation: worktree`"
直接命中 — 我们在 Claude Code 之前就有这个抽象。

#### 8. Skills

`packages/core/src/skills/Skill.ts` 定义 Skill 接口；`agentsMd.ts` 解析
`SKILL.md` 文件；`examples/skills-demo` 有 21 个示例。Skill 可以注入
ToolDefinition、system prompt addendum、metadata。

**对应文档**：第 50 行"`SKILL.md` 等文档，自动化里 `$skill-name` 一行调用"。
我们的 Skill 比文档说的更结构化（不只是文档，是可程式化注入的对象）。

#### 9. Memory / State

四层抽象：
- `Checkpointer` — pause/resume snapshot（HITL + crash recovery）
- `StructuredMemory` — 跨 session 的 namespaced KV（episodic / semantic / procedural）
- `ObservationalMemory` — 同 session 内的 step-level 压缩
- `MemoryBlockSet` — Letta 风格的 in-context 可编辑状态块（2026-06-14）

**对应文档**：第 53 行"文件系统、Git、Linear 看板"。我们更全面 — 提供四种
不同 lifecycle 的存储，应用挑用。详见 `docs/guides/memory.md`。

#### 10. `/goal` 声明式原语 (`GoalAgent`)

2026-06-15 加的 `GoalAgent`：用户声明 `{ describe, verify }`，agent 反复
迭代直到 `verify()` 返回 true 或撞预算/步数上限。

**关键设计**：`verify` 必须是**确定性、机器可判定**的（跑测试看 exit code、
检查文件、grep 输出），**不能用 LLM 做模糊判断** —— 那会立刻让 reward
hacking 出现（详见 [[reward-hacking]]）。

**对应文档**：第 64-68 行 `/goal "test/auth 下所有单元测试通过，且 lint 无报错"`。
agentkit 的 `GoalAgent` 是 SDK-level 等价物。Claude Code 的 `/goal` 是 CLI
slash command；agentkit 的 `GoalAgent` 是可嵌入任何 Node.js 应用的类。

#### 11. Reward-Hacking 防御 — IPT (Isomorphic Perturbation Test)

`iptShortcutRate(cohort)` + `iptClassify(verdict)` —— 给一组 (canonical, perturbed[])
任务对的 pass/fail 数据，输出 cohort 级 shortcut rate + 三档分类
（clean / suspicious / likely-shortcut）。

**对应论文**：Helff et al., *LLMs Gaming Verifiers: RLVR can Lead to Reward
Hacking* (ICLR 2026 Workshop, arXiv:2604.15149)。论文证明 IPT 几乎可以把
shortcut rate 压到零。

**用法**：在 evals-runner suite 里写一组同结构、不同 surface form 的任务对：

```ts
import { iptShortcutRate, iptClassify } from "@wasmagent/evals-runner";

// 跑了一个套件，得到每个任务的 pass/fail
const cohort = [
  { id: "rename-1", original: passedOnOldNew, perturbed: [passedOnAB, passedOnInputOutput] },
  // ...
];
const verdict = iptShortcutRate(cohort);
console.log(`shortcut rate: ${verdict.shortcutRate}, verdict: ${iptClassify(verdict)}`);
```

> 0.25 的 cohort 是 likely-shortcut signal — 相当于 RLVR 训练后的模型在
extensional verifier 下的典型行为。

#### 12. 沙箱与 Capability 限制（执行安全核心）

`CapabilityManifest` 是 agentkit 的统一安全抽象，跨 in-process / WASM /
remote 三层 kernel 一致：

```ts
{
  allowedHosts: ["api.example.com"],
  allowedReadPaths: ["./project"],
  allowedWritePaths: ["./project/src"],
  env: { ALLOWED_ENV: "value" },
  cpuMs: 5000,
  memoryLimitBytes: 100_000_000,
}
```

**对应文档第 82-85 行**：EurekAgent 的"权限工程 / 产物工程 / 预算工程"
四维度 — agentkit 通过 CapabilityManifest 一次性提供前三个的接口
（HITL 是第四个，由 Checkpointer 提供）。

#### 13. Token / 步数 / 时间预算

三层防御：
- `TokenBudget` 类 — 累计 tokens
- `costBudget(maxTokens)` StopCondition — 触发即终止 agent
- `EnhancementPolicy.budget.maxDurationMs` — 时间上限
- `GoalAgent.tokenBudget` — 跨 iteration 的累计预算
- 每个 agent 的 `maxSteps`

**对应文档第 84 行**：预算工程 + 第 202 行"步数上限 = 5 / Token Budget"。
我们覆盖完了。

---

## 跟 Loop Engineering 论文派对照的"我们独有"

agentkit-js 提供了 Loop Engineering 文献里**没有但应该有**的两个东西：

### A. 跨 kernel tier 的统一安全面（CapabilityManifest）

Loop Engineering 论文谈"沙箱"，但只举一个例子（forkd / Firecracker microVM）。
agentkit 的 `CapabilityManifest` 让**同一份 policy** 在三个 kernel tier
（in-process VmKernel / WASM / remote microVM）一致执行 —— 应用可以从
开发环境的 in-process 平滑过渡到生产的 microVM，policy 不变。

### B. Memory 的四层 lifecycle 抽象

Loop Engineering 文献谈"状态外置"，但只到"文件 / Git" 粒度。agentkit 的
四层 memory（Checkpointer / StructuredMemory / ObservationalMemory /
MemoryBlockSet）覆盖从"本轮内压缩"到"跨 session user fact"的完整谱系。
详见 `docs/guides/memory.md`。

---

## 怎么用 agentkit-js 搭一个完整 Loop Engineering 系统

按照 6 组件 + L1/L2/L3 分层 + verifier，一份最小骨架：

```ts
import {
  GoalAgent,
  ToolCallingAgent,
  StructuredMemory,
  InMemoryStructuredKv,
  Checkpointer,
  CapabilityManifest,
} from "@wasmagent/core";
import { iptShortcutRate } from "@wasmagent/evals-runner";

// 1. 状态层
const memory = new StructuredMemory(new InMemoryStructuredKv());
const checkpointer = /* KvCheckpointer */;

// 2. 工具 + 沙箱（capabilities 跨 kernel tier 一致）
const capabilities: Partial<CapabilityManifest> = {
  allowedHosts: ["registry.npmjs.org"],
  allowedWritePaths: ["./working"],
  cpuMs: 30_000,
};

// 3. L2 执行层 (medium model)
const l2Agent = new ToolCallingAgent({
  model: l2Model,        // e.g. Claude Sonnet
  tools: [/* repo tools */],
  maxSteps: 15,
});

// 4. L3 协调层 — 包装成 GoalAgent
const goalAgent = new GoalAgent({
  model: l3Model,        // e.g. Claude Opus
  tools: [/* delegate to l2Agent via asTool() */],
  maxIterations: 5,
  tokenBudget: 200_000,
});

// 5. L1 验证层 — verify 函数里调本地工具/小模型，不是 LLM
async function verifyTestsPass() {
  const { exitCode, stdout } = await execTestsCommand();
  if (exitCode === 0) return { ok: true } as const;
  return { ok: false, hint: stdout.slice(-500) };
}

// 6. 跑
const events: AgentEvent[] = [];
for await (const ev of goalAgent.run({
  describe: "Make all unit tests in test/auth pass",
  verify: verifyTestsPass,
})) {
  events.push(ev);
}

// 7. （可选）跑完后用 IPT 量 reward-hacking 倾向
const iptVerdict = iptShortcutRate(/* cohort built from runs */);
if (iptVerdict.shortcutRate > 0.25) {
  console.warn("model showed shortcut behaviour — re-evaluate your verifier");
}
```

每一行都是 agentkit 现有的 API。**没有任何新基础设施需要建**。

---

## 不打算追的赛道（战略层面）

agentkit 不会和 Claude Code / Codex CLI 在"通用软件工程 Loop"正面竞争。理由：

- 那个赛道顶端已被两个最大资金方占住
- 护城河（Evaluation engineering + 模型质量 + 数据飞轮）正好是独立 SDK 最缺的
- "我先实现完整循环"不是壁垒（worktree 是 git 命令封装、automations 是 cron）

agentkit 走的是文档 §第 3 节的**侧翼**：

- **本地优先 / 隐私敏感**：Claude Code 是云服务，agentkit 给"循环必须在本地跑"的客户
- **L1 验证层下沉到本地**：把循环里 60% 的高频小活儿从计费 API 移到本机
- **被嵌入的运行时**（ROADMAP S1）：agentkit 是 Loop Engineering 基础设施，不是 Loop Engineering 成品

`GoalAgent` + `IPT scorer` + 现有 memory / sandbox / capability 抽象 —— 这套
组合是"小模型 + 本地 L1 验证层"这个无人区的工程基础。

---

## 参考

- 茜布 / Addy Osmani / Boris Cherny — Loop Engineering 概念溯源（2026-06）
- EurekAgent (arXiv:2606.13662, 2026-06-11) — 环境工程四维度
- RHB (arXiv:2605.02964, 2026-05) — Reward Hacking 实测基准
- Helff et al. (arXiv:2604.15149, ICLR 2026 Workshop) — IPT 来源
- Anthropic *From shortcuts to sabotage* (2025-11-21) — 失准泛化的安全红线
- agentkit-js [Memory guide](./memory.md)
- agentkit-js [Reward Hacking guide](./reward-hacking.md) (planned)
- agentkit-js `MEMORY.md` →
  [project_desktop_agent_feasibility_2026_06_13.md](../../../.claude/projects/-Users-I041705-github-agentkit-js/memory/project_desktop_agent_feasibility_2026_06_13.md)
