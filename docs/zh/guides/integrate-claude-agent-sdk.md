# 在 Claude Agent SDK 中使用 wasmagent kernel

> 最后更新：**2026-06-12**。
> 配套指南：[`integrate-vercel-ai-sdk.md`](integrate-vercel-ai-sdk.md)
> 和 [`integrate-openai-agents.md`](integrate-openai-agents.md)。

Anthropic 的 Claude Agent SDK 针对 `claude-{haiku|sonnet|opus}-*` 运行 agent 循环，
当模型输出 `tool_use` 块时执行用户定义的工具。默认的工具执行路径直接运行你的处理器——
与你的服务具有相同的信任边界。当 LLM 在生成即将运行的代码（数学计算、JSON 处理、
多步工作流）时，这个边界过于宽松。

`@wasmagent/claude-agent-sdk` 提供两个工厂函数，生成的 Claude Agent SDK 工具
其处理器是一个沙箱 kernel：

- **`sandboxedJsClaudeTool`** — 单次 JS 求值器。
- **`codeModeClaudeTool`** — code-mode 工具（一个工具入口，N 个可调用的下游工具）；
  参见 [`code-mode.md`](code-mode.md) 了解更多背景。

两者都遵循统一的 `CapabilityManifest`，因此你已经为 `@wasmagent/mcp-server` 编写的
策略可以直接使用——参见
[`docs/strategy/security-face.md`](/strategy/security-face.md)。

## 安装

```bash
npm add @wasmagent/claude-agent-sdk @wasmagent/core @wasmagent/kernel-quickjs @anthropic-ai/sdk
```

`@anthropic-ai/sdk` 对等依赖声明为*可选*——适配器只输出工具的结构形状，因此你也可以将其
接入消费相同 `{name, description, input_schema, handler}` 四元组的 Bedrock 或 Vertex 传输层。

## 代码片段 — sandboxedJsClaudeTool

```ts
import Anthropic from "@anthropic-ai/sdk";
import { sandboxedJsClaudeTool } from "@wasmagent/claude-agent-sdk";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const tool = sandboxedJsClaudeTool({
  kernel: new QuickJSKernel(),
  capabilities: {
    allowedHosts: ["api.example.com"], // 最窄的网络策略
    cpuMs: 5_000,
    memoryLimitBytes: 64 * 1024 * 1024,
  },
});

const client = new Anthropic();
const turn = await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 512,
  tools: [
    {
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    },
  ],
  messages: [{ role: "user", content: "What is the cube of 17?" }],
});

// 当 turn.content 包含 tool_use 块时：
for (const block of turn.content) {
  if (block.type === "tool_use" && block.name === tool.name) {
    const result = await tool.handler(block.input);
    // …将 `result` 作为 tool_result content block 回传给 SDK。
  }
}
```

处理器返回 `{ output, logs }`——模型看到代码片段的返回值，以及它产生的任何 `console.log` 输出。

## 代码片段 — codeModeClaudeTool

```ts
import { codeModeClaudeTool } from "@wasmagent/claude-agent-sdk";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { ToolRegistry } from "@wasmagent/core";

const reg = new ToolRegistry();
reg.register({ /* 工具定义——参见 ToolRegistry 文档 */ });

const tool = codeModeClaudeTool({
  kernel: new QuickJSKernel(),
  tools: reg,
});

// 现在 Claude 只看到一个工具——`execute_code`。其代码片段可以
// 通过 callTool("name", args) 调用任意已注册工具，只有最终返回值
// 重新进入 Claude 的上下文。
```

为什么值得这样做：在 N=30 个用户定义工具时，code-mode 使用的 token 不超过直接工具使用模式的 14%
（见 [`examples/benchmarks/code-mode-tokens.mjs`](../../examples/benchmarks/code-mode-tokens.mjs)）。
token 节省在结构上是必然的——模型从目录中选择一个工具，而不是 N 个——并与 prompt 缓存叠加。

## Capability manifest 速查

`capabilities` 选项原封不动地传递给 kernel。
各字段及其跨 kernel 执行矩阵见
[`docs/strategy/security-face.md`](/strategy/security-face.md)。

针对第三方 LLM 工作负载的最小合理 manifest：

```ts
{
  allowedHosts: [],            // 禁止网络
  allowedReadPaths: [],        // 禁止 FS 读取
  allowedWritePaths: [],       // 禁止 FS 写入
  cpuMs: 5_000,                // 5s 墙钟上限
  memoryLimitBytes: 64_000_000 // 64 MB
}
```

每次只放开一个字段，测试后再放开下一个。

## 何时用哪个工具

| 场景                                                          | 工具                                |
|---------------------------------------------------------------|-------------------------------------|
| 单次代码片段（数学、JSON 处理、解析）                          | `sandboxedJsClaudeTool`             |
| 模型需要串联 ≥3 个已注册工具                                   | `codeModeClaudeTool`                |
| 即使在串联场景下也想要单一工具入口                             | `codeModeClaudeTool`                |
| Worker / edge 环境（无 node:vm）                              | 任意，配合 `QuickJSKernel`          |
| 多租户 SaaS / 不可信代码                                       | 任意，配合 `RemoteSandboxKernel`    |

Kernel 选择决策树见
[`docs/kernels/comparison.md`](/kernels/comparison.md)。同一个 kernel 可在三个上游适配器
（`@wasmagent/aisdk`、`@wasmagent/openai-agents`、`@wasmagent/claude-agent-sdk`）
下免配置复用。
