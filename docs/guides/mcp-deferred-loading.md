# MCP 工具的延迟加载（Deferred Loading）

> **背景**：当一个 Agent 暴露了几十甚至上百个工具（典型场景：MCP server 接入了多个外部数据源），把所有工具的 schema 一次性塞进 system prompt 是巨大的 token 浪费。
>
> 这篇说明 wasmagent-js 的延迟加载机制，并把 [`examples/benchmarks/defer-loading.mjs`](https://github.com/WasmAgent/wasmagent-js/blob/main/examples/benchmarks/defer-loading.mjs) 验证的 **−85% token** 数字背后的原理交代清楚。

## 机制

wasmagent-js 把工具拆成两层：

1. **Discovery 层** — 一段精简的总览（每个工具 ~10 token），说明"这里有 X 个可用工具，分类如下"。
2. **Detail 层** — 完整 schema（输入/输出 zod 定义、描述、示例）。仅在 agent 决定使用某工具的那一回合才加载。

实际效果：

```
传统做法（无 deferred loading）:
  [system prompt] [tool schemas × 100] = 15,000 tokens / 每回合
  
wasmagent-js + deferred:
  [system prompt] [tool index × 100]   = 1,000 tokens / 每回合
  + 触发后再注入完整 schema             = 100 tokens × 命中工具数
```

在 [defer-loading benchmark](https://WasmAgent.github.io/wasmagent-js/benchmarks) 里，10 工具每个 1500 token 的设定下：

| 模式 | 总 token |
|---|---:|
| 全量加载 | 15,000 |
| Deferred + 命中 1 工具 | 1,500 |
| **节省比** | **90 %** |

## 与 Mastra 的差异

- Mastra 的 "first-class MCP" 文档强调 **接入便利**（一个包含 30 个 MCP server 的项目能开箱即用）。
- wasmagent-js 的关注点是 **大规模工具集下的 token 成本**。`SkillRegistry`（A3 progressive disclosure）和 `mcpDiscover`（懒加载）是同一个问题的两面。

两者并不互斥；你可以在同一个项目中用 Mastra 的 MCP 注册系统接入工具，再把 wasmagent-js 的 SkillRegistry 套在外层做成本控制 —— 见 [Use kernels with Mastra](./integrate-mastra.md) 中的同款套路。

## 实现位置

- 索引层结构：`packages/core/src/skills/SkillRegistry.ts`
- MCP 适配：`packages/mcp-server/` 的客户端模式
- 验证基准：`examples/benchmarks/defer-loading.mjs`（CI 守门，drift > ±10% 就失败）
