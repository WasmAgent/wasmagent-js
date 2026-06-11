# AGENTS.md project conventions

`AGENTS.md` 是 Codex / Cursor / Copilot / Gemini 共用的项目约定文件 —— 在仓库根目录或子目录放一个 Markdown，列明项目的代码风格、构建命令、不要碰的目录等等，让 agent 在产生改动前先读懂这些规则。

## 在 agentkit-js 里启用

agentkit-js 不在 core 里强制 AGENTS.md 协议（保持框架的中立性 — 见 [Generic Foundation Principle](https://github.com/telleroutlook/agentkit-js#design-principles)），但提供了"加到 system prompt 前缀"的清晰套路。bscode 的实现是参考做法。

```ts
import { CodeAgent } from "@agentkit-js/core";

// 自己的辅助函数，把仓库 AGENTS.md 拼成系统提示前缀
function loadAgentsMd(workspaceRoot: string): string {
  const root = readAgentsMdAt(workspaceRoot);                 // 仓库根
  const nested = collectNestedAgentsMd(workspaceRoot);        // 子目录覆盖
  // 顺序：广→近（"later wins"）
  return [root, ...nested].filter(Boolean).join("\n\n---\n\n");
}

const agent = new CodeAgent({
  model,
  systemPrompt: defaultSystemPrompt + "\n\n" + loadAgentsMd(cwd),
});
```

## 解析顺序：广→近

LLM 处理 system prompt 时存在 "later-wins" 偏好 —— 越靠后的指令优先级越高。因此 AGENTS.md 的合并顺序应该是：

1. 仓库根 `AGENTS.md`（最广，最常被覆盖）
2. 上层目录 `AGENTS.md`（如 `apps/AGENTS.md`）
3. 当前目录 `AGENTS.md`（最近，最具体，最后放）

bscode 在 [`apps/worker/src/app.ts`](https://github.com/WasmAgent/bscode/blob/main/apps/worker/src/app.ts) 中实现了这条顺序，每次 `/run` 都重新读取（因为 agent 自己可能修改 AGENTS.md），并把空 workspace 的情况降级为空字符串以避免幻觉。

## init_agents_md 工具（HITL 门）

bscode 还提供了一个 `init_agents_md` 工具，让 agent 自己起草 AGENTS.md：

- `readOnly: true`、`idempotent: true` —— 它只产出文本，不写盘
- `needsApproval: true` —— 实际落盘必须走 planFirst HITL 审批

把它抽到 `packages/core/tools/` 是后续路线图（参见 [bscode/agentsMd.ts](https://github.com/WasmAgent/bscode/blob/main/apps/worker/src/tools/agentsMd.ts) 的 141 行实现），目前先以"最佳实践文档"形式提供。

## 适用边界

- ✅ 多 agent 协作（Codex、Cursor、Claude Code、agentkit-js 都能消费同一份 AGENTS.md）
- ✅ 仓库级约定（构建命令、风格、目录边界）
- ❌ **机密信息** —— AGENTS.md 进 system prompt，会出现在每次 model 调用中；不要放 secrets

## 进一步阅读

- [agents.md spec](https://agentsmd.net/) — Codex / Cursor / Copilot / Gemini 共识
- bscode 的 [C4 deep dive](https://github.com/WasmAgent/bscode/blob/main/docs/C4-agents-md.md)（如该文档存在）
