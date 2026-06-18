# 把 agentkit agent 暴露为 MCP server（F1）

`@wasmagent/mcp-server` 包能把任何运行起来像 agent 的对象——`ToolCallingAgent`、`CodeAgent`、自定义 `SubagentRunnable`——包装成 Model Context Protocol server。已经讲 MCP 的宿主（Claude Code、Cursor 2.4+、Copilot、Gemini CLI、Bedrock AgentCore、Microsoft Agent Framework）就能像调用任何 MCP 工具一样调你的 agent ——列举其能力、同步调用、或发起长任务后续轮询。

## 为什么有它

wasmagent 此前是单向的 MCP 公民：通过 `McpToolCollection` 消费 MCP server，但没有宿主能调 wasmagent agent。F1 闭环。同一个跑你 agent 的 Workers/Node 部署，现在自带 MCP 端点 —— 无需额外服务、无协议漂移。

## 快速上手

```ts
import { ToolCallingAgent } from "@wasmagent/core";
import {
  McpAgentServer,
  createFetchHandler,
  InMemoryTaskStore,
} from "@wasmagent/mcp-server";

const agent = new ToolCallingAgent({ /* 你的 agent */ });

const server = new McpAgentServer({
  serverInfo: { name: "my-coding-agent", version: "1.0.0" },
  agent,
  // 默认：单工具 'run_agent'，参数 { task: string }。
  // 你也可以显式传一组更窄的工具发布出去。
  taskStore: new InMemoryTaskStore(), // 生产换成 KV 后端
});

// Streamable HTTP — 可在 Cloudflare Workers、Bun.serve、Node 18+ 工作。
const handler = createFetchHandler(server, { path: "/mcp" });

// 在你的 worker 里：
export default {
  async fetch(request: Request) {
    return handler(request);
  },
};
```

宿主配置你的端点：

```jsonc
{
  "mcpServers": {
    "my-coding-agent": {
      "url": "https://my-worker.workers.dev/mcp"
    }
  }
}
```

`initialize` 后宿主可调 `tools/list`、`tools/call`、`tasks/create`、`tasks/get`、`tasks/cancel`、`tasks/respond`。下层 agent 每次调用跑一次；事件流入持久化的 task 记录，所以 worker 回收不会丢进度。

## 方法

| Method | 用途 | 备注 |
|---|---|---|
| `initialize` | 能力握手 | 返回 `protocolVersion: "2025-11-25"` 和 `capabilities.tools` + `capabilities.tasks` |
| `tools/list` | 列出已发布工具 | `_meta.longRunning` 提示路由到 Tasks |
| `tools/call` | 同步工具调用 | `syncTimeoutMs` 触发时自动升级到 Tasks，响应携带 `_meta.taskId` |
| `tasks/create` | 启动长任务 | 返回 `{ id, state: "pending" }` |
| `tasks/get` | 轮询 task | 返回完整 `McpTaskRecord`：state、events、result、error 或 pending elicitation |
| `tasks/cancel` | 取消进行中的 task | state 设为 `failed` 并 `error: "cancelled by host"` |
| `tasks/respond` | 回应 elicitation | agent 发出 `await_human_input` 后必需 |
| `tasks/list` | 枚举 task | 可选 — 取决于 store 是否实现 `list()` |
| `ping` | 存活检查 | 返回 `{}` |

## 长任务（2025-11-25 Tasks API）

当 agent 工作超过 `syncTimeoutMs`（默认 25 s），同步 `tools/call` 响应透明升级到 Tasks API。宿主拿到 `{ _meta: { taskId } }` 后轮询 `tasks/get` 直到 `state` 为 `complete`、`failed` 或 `awaiting-input`。

`McpAgentServer` 在后台保持运行；持久化记录走 `pending → running → complete | failed | awaiting-input`。每发出 5 个 agent 事件就 flush 到 task store，5 分钟任务中途回收最多丢 ≤4 个事件。

## 重启间无状态

server 不持有任何**内存中会话状态**。每个方法都把 task id 作为参数；其余从配置的 `McpTaskStore` 读。这是 2026-07-28 Release Candidate 的设计，移除了 session-id 概念。要扛 worker 回收：

1. 用 KV 后端的 `McpTaskStore`（给你的 KV 写 30 行 adapter；`taskStore.ts` 中的 in-memory 实现就是契约）。
2. 让被包的 agent 自身可恢复 — 如果 agent 用 `KvCheckpointer`，恢复路径已经能跑。MCP server 把 task 当 `agent.run(task)` 的黑箱 run；如果那个 generator 能在回收后被重新进入，server 的持久化就够了。

## Elicitation（await_human_input）

agent 发 `await_human_input` 时，server：

1. 在 task 上记 `pendingElicitation`，state 切到 `awaiting-input`。
2. 停止 run — generator 由 agent 的 checkpoint 层持有，**不是** MCP server。
3. 通过 `tasks/get` 把 prompt 露给宿主（在 `elicitation` 字段回显）。

宿主用 `tasks/respond` 提交用户回应；server 清除 pending 字段并把 state 翻回 `running`。从那点恢复 agent 实际 generator 是宿主 `CheckpointableRun` 的责任 — F1 故意不接管该路径（接了会在 codebase 内创建两个并行恢复机制）。

## 工具粒度自定义

通过传 `tools` 选项发布多个工具：

```ts
new McpAgentServer({
  serverInfo: { name: "...", version: "1.0" },
  agent,
  tools: [
    {
      name: "summarise_pr",
      description: "总结 GitHub PR（按 URL）。",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      // 把宿主的结构化参数转成 agent 期望的 task 字符串。
      resolveTask: ({ url }) => `总结这个 PR: ${url}`,
    },
    {
      name: "deep_research",
      description: "多源研究 + 验证 — 长任务。",
      inputSchema: { type: "object", properties: { question: { type: "string" } } },
      longRunning: true,
      resolveTask: ({ question }) => `Research: ${question}`,
    },
  ],
});
```

`longRunning: true` 的工具不论 `syncTimeoutMs` 都走 `tasks/create`。

## 规范遵守

- 锚定 MCP **2025-11-25** 稳定版以便兼容所有目前发货的宿主。
- 在 **2026-07-28 RC** 约束内设计：不依赖 session-id、不主动发起请求、elicitation 仅在活动请求响应内。
- JSON-RPC 2.0 信封、批量支持、标准 `-32700 / -32600 / -32601 / -32602 / -32603` 错误码以及 MCP 扩展 `-32010 / -32011 / -32012`（task-not-found / tool-not-found / task-not-awaiting）。
