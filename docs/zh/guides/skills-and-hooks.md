# Skills & 生命周期 hook

> **A3** — 指令和工具的渐进披露（progressive disclosure）+ 后置工具 hook 链（用于审计/脱敏/规范化）。对齐 Claude Agent SDK SKILL.md / CrewAI v1.12 / Pydantic AI Capabilities — 2026 框架普遍收敛到的约定。

agentkit-js 已有 `deferLoading` 处理工具 schema。A3 把这一思路扩展到**整个 skill bundle**（指令 + 工具），并新增 **post-tool hook**，与已有的 `ToolGuardrail`（pre-tool hook）配对。

---

## Skills

skill 是 `(name, description, trigger, lazyBody)` —— `lazyBody` 仅在 skill 被激活时才产出真正的 `(instructions, tools)`。在那之前 agent 只看到 description（短文本，绝不污染 prompt）。

### 快速上手

```ts
import { SkillRegistry } from "@agentkit-js/core";

const registry = new SkillRegistry();

registry.register({
  name: "react-build",
  description: "搭建一个 React + Vite + TypeScript 应用",
  trigger: (task) => /react|vite/i.test(task),
  load: async () => ({
    instructions: `
      ## Phase 1: Plan
      把计划包在 <boltThinking> 标签里…
      ## Phase 2: Generate Files
      1. package.json   2. vite.config.ts   3. index.html …
    `,
    tools: [scaffoldReactTool, lintReactTool],
  }),
});

// 按 task 解析 — 匹配 trigger，懒加载命中的 body。
const resolved = await registry.resolveForTask(task);
if (resolved) {
  systemPrompt += "\n\n" + resolved.instructions;
  tools.push(...resolved.tools);
}
```

### API

```ts
class SkillRegistry {
  register(skill: Skill): void;
  list(): SkillManifest[];                 // 热路径 — 仅 description
  describe(): string;                       // markdown 列表
  match(task: string): Promise<SkillManifest[]>;
  activate(name: string): Promise<ActivationResult>;  // 懒加载 body，缓存
  resolveForTask(task: string):
    Promise<{ instructions: string; tools: ToolDefinition[]; activated: string[] } | null>;
}
```

### 何时用哪种

- **`trigger`**：便宜的谓词。匹配器在每个 task 上跑；如果有几千个 skill，优先用 regex / token 存在检查。LLM 路由的激活，把小分类模型包成 closure 即可，但要记得每个 task 多一次推理。
- **无 trigger**：skill 是"显式 only" — 只在 host 应用调 `activate(name)` 时加载。适合 UI 上用户主动开启的工作流。
- **`tags`**：可选，在 `list()` 中暴露 — 仪表盘有用。

### 它**不是**什么

- Skill **不是** Claude SDK MCP server。两者都可以扩展 agent；skill 是与本次 run 一起 bundle 的，MCP server 是独立进程。配合用即可。
- Skill **不是** subagent。Subagent 是独立的 run（独立 `run()` 调用、独立事件流）；skill 是当前 run 的 prompt 和工具注册表的一部分。

---

## 生命周期 hook（pre / post tool）

Pre-tool hook 已存在，叫 `ToolGuardrail` — 它可以通过返回 `tripwireTriggered: true` **阻止**工具调用。Post-tool hook 是新搭档：在工具运行后观察，可以在 agent 看到之前重写输出。

### 为什么是两层而不是一层

Pre-hook 守门；post-hook 变换。混在一起会混淆意图 — `denyTools(...)` 和 `redactPostHook(...)` 触发时含义完全不同。分开让模型显式。

### Post-hook 契约

```ts
interface ToolPostHook {
  readonly name: string;
  after(toolName: string, ctx: ToolPostHookContext):
    | Promise<void | { rewrite: unknown }>
    | void
    | { rewrite: unknown };
}
```

- 返回 `undefined` → 输出不变（仅审计 / 日志）。
- 返回 `{ rewrite: <new> }` → agent 看到 `<new>`。
- Hook 串联 — 每个 rewrite 喂给下一个 hook（按注册顺序）。
- Hook 抛出的错误被记录但**不**传播。

### 内置 hook

```ts
import { redactPostHook, truncatePostHook } from "@agentkit-js/core";

// 把 API key 替换成 [REDACTED]
const redact = redactPostHook({ pattern: /sk-[a-z0-9]{6,}/gi });

// 把巨型工具输出截到最后 4 KB
const truncate = truncatePostHook({ maxChars: 4_000 });

// 在 runner 里用：
import { runToolPostHooks } from "@agentkit-js/core";
const safe = await runToolPostHooks([redact, truncate], toolName, rawOut, {
  input,
  durationMs,
});
```

### 接入 agent run

Hook 是纯函数；在工具调用循环里，工具解析后立即接入：

```ts
const rawOutput = await tool.forward(input);
const finalOutput = await runToolPostHooks(
  postHooks,
  tool.name,
  rawOutput,
  { input, durationMs: Date.now() - start, originalTask },
);
assembler.addStep({ type: "tool_call", toolName, toolInput: input, toolOutput: finalOutput });
```

---

## 同时参见

- `packages/core/src/skills/Skill.ts` — registry 实现
- `packages/core/src/skills/Skill.test.ts` — 9 个测试覆盖懒加载、缓存、多 skill 组合、易出错 trigger 隔离、重复注册检测
- `packages/core/src/guardrails/index.ts` — `ToolPostHook` + 内置 helper（redact、truncate）
- `packages/core/src/guardrails/index.test.ts` — 7 个 post-hook 测试
- [agent-prompts/](../../packages/agent-prompts/) — 可组合的 prompt 片段；与 skills 搭配组成完整的 system prompt 故事
