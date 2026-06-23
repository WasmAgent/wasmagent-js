# 在 OpenAI Agents JS SDK 中使用 wasmagent kernel

> 最后更新：**2026-06-12**。
> 配套指南：[`integrate-vercel-ai-sdk.md`](integrate-vercel-ai-sdk.md)
> 和 [`integrate-claude-agent-sdk.md`](integrate-claude-agent-sdk.md)。

OpenAI Agents JS SDK（`@openai/agents`）通过 `agent({ tools: […] })` 注册类型化工具来运行
agent 循环。默认的工具执行路径直接运行你的 `execute()` 函数。当 LLM 在生成即将运行的代码时，
这根本不是隔离——而是隔离的反面。

`@wasmagent/openai-agents` 生成的工具，其 `execute` 是一次 wasmagent kernel 运行：

- **`sandboxedJsAgentTool`** — 单次 JS 求值器。
- **`codeModeAgentTool`** — code-mode 工具（一个工具入口，N 个可调用的下游工具）。

两者都遵循统一的 `CapabilityManifest`。你为 MCP server 或其他适配器做出的 capability 决策
可以直接套用——参见 [`docs/strategy/security-face.md`](../strategy/security-face.md)。

## 安装

```bash
npm add @wasmagent/openai-agents @wasmagent/core @wasmagent/kernel-quickjs @openai/agents
```

`@openai/agents` 对等依赖声明为*可选*，这样单元测试不会将其拉入。运行时你的应用需要它
才能将工具接入 `Agent`。

## 代码片段 — sandboxedJsAgentTool

```ts
import { Agent } from "@openai/agents";
import { sandboxedJsAgentTool } from "@wasmagent/openai-agents";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const sandboxed = sandboxedJsAgentTool({
  kernel: new QuickJSKernel(),
  capabilities: {
    allowedHosts: [],
    cpuMs: 5_000,
    memoryLimitBytes: 64 * 1024 * 1024,
  },
});

const agent = new Agent({
  name: "math-helper",
  instructions: "You are a careful arithmetic assistant.",
  tools: [sandboxed],
});

const turn = await agent.run("What is the cube of 17?");
console.log(turn.finalOutput);
```

Agent 选择 `sandboxed_js`，提供代码片段，kernel 运行它，结果 `{ output, logs }` 成为下一轮
模型看到的工具结果。

## 代码片段 — codeModeAgentTool

```ts
import { Agent } from "@openai/agents";
import { codeModeAgentTool } from "@wasmagent/openai-agents";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { ToolRegistry } from "@wasmagent/core";

const reg = new ToolRegistry();
reg.register({ /* 工具定义——参见 ToolRegistry 文档 */ });

const codeMode = codeModeAgentTool({
  kernel: new QuickJSKernel(),
  tools: reg,
});

const agent = new Agent({
  name: "workflow-runner",
  instructions: "Use execute_code to chain registered tools when needed.",
  tools: [codeMode],
});
```

Agent 现在只看到一个工具——`execute_code`。其代码片段可以通过 `callTool(name, args)` 调用
`reg` 中的任意工具，只有脚本的最终返回值重新进入模型的上下文。

## Capability manifest 速查

```ts
{
  allowedHosts: [],            // 禁止网络
  allowedReadPaths: [],        // 禁止 FS 读取
  allowedWritePaths: [],       // 禁止 FS 写入
  cpuMs: 5_000,
  memoryLimitBytes: 64_000_000,
}
```

各字段的跨 kernel 执行矩阵见
[`docs/strategy/security-face.md`](../strategy/security-face.md)。

## 何时用哪个工具

| 场景                                                          | 工具                              |
|---------------------------------------------------------------|-----------------------------------|
| 单次代码片段（数学、JSON 处理、解析）                          | `sandboxedJsAgentTool`            |
| 模型需要串联 ≥3 个已注册工具                                   | `codeModeAgentTool`               |
| 即使在串联场景下也想要单一工具入口                             | `codeModeAgentTool`               |
| Worker / edge 环境                                            | 任意，配合 `QuickJSKernel`        |
| 多租户 SaaS / 不可信代码                                       | 任意，配合 `RemoteSandboxKernel`  |

Kernel 决策树：[`docs/kernels/comparison.md`](../kernels/comparison.md)。
