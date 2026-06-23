# wasmagent-js 中的 Memory

> 一站式入口。如果你在 2026 年听说过"agent 记忆"——Mem0、Letta、Zep、
> OpenAI Sessions、Anthropic memory tool——本指南会告诉你 wasmagent-js
> 对应的原语是什么、各自的适用场景，以及需要注意的坑。

wasmagent-js 提供**八个**与记忆相关的原语。它们不是替代关系——它们是栈中的各个层，
真实的生产 agent 通常同时使用其中两三个。问题不是"选哪一个"，而是"哪种组合
匹配我的运行生命周期"。

本指南是地图。它链接的参考页面是领土。

## TL;DR — 决策树

```
需要保留什么？
├─ 当前 agent.run() 调用内部的步骤
│  ├─ 仅消息前缀，对 prompt 缓存友好
│  │  → MessageAssembler        （每个 agent 内置）
│  ├─ 上下文增长时的步骤级摘要
│  │  → ObservationalMemory     （廉价观察者模型 + KV）
│  └─ 一个小型可编辑便签本
│     → MessageAssembler.setScratchpad()
│
├─ 每轮可见的身份和短期 agent 状态
│  → MemoryBlockSet             （Letta 风格的核心记忆）
│
├─ 跨运行的用户事实、偏好、习得技能
│  ├─ 应用写入、应用读取
│  │  → StructuredMemory        （3 个命名空间，带 TTL：episodic / semantic / procedural）
│  └─ Agent 自主决定写入/读取
│     → createMemoryTool        （4 个操作的 CRUD 工具；agent 可调用）
│
├─ Agent 在查询时应检索的文档
│  ├─ 单一语料库，临时性
│  │  → InMemoryVectorStore + HybridRetriever
│  └─ 持久索引，可扩展
│     → KvBackendVectorStore  /  Pinecone  /  Qdrant  （通过 @wasmagent/tools-rag）
│
└─ 跨进程重启暂停/恢复进行中的运行
   → Checkpointer               （生产用 KvCheckpointer）
```

## 2026 年"记忆"的含义（以及 wasmagent 如何称呼每个部分）

vendor 格局（Mem0、Letta、Zep、OpenAI Agents SDK、Anthropic SDK、LangGraph、
Microsoft Agent Framework）已经汇聚到少数几个独立概念上。wasmagent-js 实现了
全部；命名有所不同。

| 2026 年行业概念 | wasmagent-js 等价物 | 参考 |
|---|---|---|
| 对话历史 / Session（逐轮） | `MessageAssembler`（运行内）+ `Checkpointer`（跨运行） | [memory-patterns.md](./memory-patterns.md)，[`MessageAssembler`](../../packages/core/src/memory/MessageAssembler.ts) |
| Core memory blocks（Letta）—— 可编辑的上下文内状态 | `MemoryBlockSet` + `coreMemoryTools()` | [§ 核心记忆块](#核心记忆块) |
| 每轮自动提取的事实（Mem0） | `ObservationalMemory`（廉价观察者 + 优先级排名） | [observational-memory.md](./observational-memory.md) |
| 长期命名空间 KV（LangGraph `BaseStore`） | `StructuredMemory`（3 个命名空间，TTL，衰减） | [memory-patterns.md](./memory-patterns.md) |
| 模型可调用的记忆工具（Anthropic `memory_20250818`） | `createMemoryTool()`（4 个操作的 CRUD） | [memory-patterns.md](./memory-patterns.md) |
| 混合检索（稠密 + 稀疏） | `HybridRetriever`（BM25 + 稠密 + RRF） | [memory-patterns.md](./memory-patterns.md) |
| 语料库上的 RAG | `InMemoryVectorStore` / `KvBackendVectorStore` / `@wasmagent/tools-rag` | [memory-patterns.md](./memory-patterns.md) |
| 双时态知识图谱（Zep / Graphiti） | **未实现**——自带图存储；如需可在 `StructuredMemory` 元数据中标记 `valid_at` | — |

有意留白：**双时态实体图谱是 Zep 的产品**。
在 wasmagent-js 中构建一个复制品需要大量工程投入，且主要是企业 ROI 应用场景。
wasmagent-js 将这部分留给相邻生态。

## 按生命周期选择，不要按名称选择

最清晰的心理模型是"这份数据存活多久，谁有权写入它？"

### 生命周期 A — 在一次 `agent.run()` 调用内

`MessageAssembler` 每个 agent 创建一次，随着步骤累积跟踪消息前缀。
`ObservationalMemory` 与之并行运行，当上下文超过可配置阈值（默认 6000 token）时
触发异步观察者模型，生成优先级排名的摘要，在不使 prompt 缓存失效的前提下压缩前缀。

通常你不需要直接实例化 `MessageAssembler`——每个 `ToolCallingAgent` / `CodeAgent`
都会在内部创建一个。如果你想要持续压缩，**需要**实例化 `ObservationalMemory`。
参考页面：[observational-memory.md](./observational-memory.md)。

### 生命周期 B — 同一 session 内跨 `agent.run()` 调用

`MemoryBlockSet` 是这个生命周期的新（2026-06）原语。
通过 `memoryBlocks` 配置将其传给 assembler；它会在缓存的 system 前缀之后渲染为
一条 user 角色消息。在运行之间编辑块（或让 agent 通过 `core_memory_append` /
`core_memory_replace` 编辑），下一次运行就能看到更新后的状态。

```ts
import {
  MemoryBlockSet,
  coreMemoryTools,
  ToolCallingAgent,
  MessageAssembler,
} from "@wasmagent/core";

const blocks = new MemoryBlockSet([
  { label: "persona", value: "I am a coding assistant." },
  { label: "human", value: "User name: Teller. Prefers TypeScript.", description: "current user" },
]);

const assembler = new MessageAssembler({
  systemPrompt: "You are a coding assistant.",
  toolsSchema: [...],
  memoryBlocks: blocks,
});

const agent = new ToolCallingAgent({
  model,
  tools: [...coreMemoryTools(blocks), ...otherTools],
  assembler,
});

// 第 1 次运行：agent 通过 core_memory_append 编辑 'human' 块
// 第 2 次运行：agent 在上下文中看到更新后的 'human' 块
// （如果想让块在进程重启后存活，在运行间将 blocks.list() 持久化到 KV）
```

**缓存稳定性**：块渲染在一条独立的 user 消息中——编辑块**不会**使 system 前缀缓存失效。
这是有意为之的，是与 Letta 的"渲染在 system prompt 中"定位的刻意分歧；
参见 [`MemoryBlocks.ts`](../../packages/core/src/memory/MemoryBlocks.ts) 中的设计说明。

### 生命周期 C — 跨 session（同一用户，不同运行/不同天）

两条路：

1. **应用驱动**：使用 `StructuredMemory`。你的应用将用户事实写入 `semantic` 命名空间；
   每次新运行时，应用读取回来并注入 system prompt 或填充 `MemoryBlockSet`。
   你决定 schema；agent 看不到存储层。

2. **Agent 驱动**：使用 `createMemoryTool()`。将工具提供给 agent；它会学会在有意义的
   轮次后调用 `memory_write`，在新运行开始时调用 `memory_read`。
   你在 system prompt 中决定命名约定；agent 决定什么是有意义的。

大多数生产部署两者结合——应用拥有用户身份键（`user:42:profile`），agent 拥有内容键（`note:about:rust`）。

### 生命周期 D — 跨进程重启的暂停/恢复

`Checkpointer` 用于人工在环暂停和崩溃恢复。
测试用 `InMemoryCheckpointer`；生产用 `KvCheckpointer`（任意 `KvBackend`，
包括 Cloudflare KV / Redis / Durable Objects）。
快照形状和 HITL 审批模式见 [memory-patterns.md](./memory-patterns.md)。

## 核心记忆块

本节详细介绍新（2026-06）的 `MemoryBlockSet` 原语。

### 何时使用

核心记忆块适用于以下状态：

- **体积小**（总计几百到几千字符）
- **每轮都需要读取**（不想通过工具往返来访问）
- **可中途编辑**（agent 或应用在对话进行中更新它）
- **每 session，而非永久跨用户**（长期事实请使用 `StructuredMemory`）

典型示例：agent 人设、当前用户身份、进行中的任务状态、最近做出的几个决策。

反例（使用其他原语）：完整对话历史（用 `MessageAssembler`）、大型文档
（用 `HybridRetriever`）、跨 session 用户档案（用 `StructuredMemory`）。

### 与 Letta 的区别

Letta 将核心记忆渲染在 system prompt 内部。wasmagent-js 将其渲染为缓存 system 前缀之后的
独立 user 角色消息，这样编辑块不会使 prompt 缓存失效。实际影响：在使用前缀缓存的
Anthropic / Bedrock 上，每轮编辑块的 agent 只需支付一次缓存成本（system 前缀），
而不是每轮都付（修改的块）。

agent 可调用的工具接口（`core_memory_append` / `core_memory_replace`）与 Letta 字节兼容。
学过 Letta API 的 agent 在这里可以无缝使用。

### 与 `StructuredMemory` 的区别

| | `MemoryBlockSet` | `StructuredMemory` |
|---|---|---|
| 每次模型调用都渲染 | 是（在 user 消息中） | 否（仅当应用读取后注入，或通过工具） |
| 持久化 | 默认在内存中；可手动快照到 KV | 设计上 KV 支持 |
| 大小预算 | 较小（默认 5 个块 × 2000 字符） | 无上限（TTL 管理） |
| 编辑成本 | 廉价（内存映射就地修改） | KV 写入（网络） |
| 生命周期 | 一个 session | TTL 或永久 |

如果你只需要"始终可见"或"长期保存"其中之一——选对的那个。
如果两者都需要，分层使用：块渲染短期状态；`StructuredMemory` 存储 session 开始时
应用加载到块中的长期事实。

## 常见坑

### 1. 缓存稳定性不是免费的

`MessageAssembler`、`MemoryBlockSet`、`ObservationalMemory` 都假设 system 前缀在调用之间
字节稳定。这**只在你不在运行中途编辑 `systemPrompt` 的前提下**成立。
在 system prompt 中内嵌用户名字的应用代码，每轮都会重新 tokenize 整个前缀——
在消费级延迟下没问题，在生产规模下会让成本翻倍。
改为使用 `MemoryBlock` 替代。

### 2. `MemoryTool` 是选择性的，由 agent 判断

agent 自己决定记住什么。如果你的 prompt 没有鼓励记忆写入，agent 会使用不足。
`createMemoryTool()` 的 docstring 列出了推荐的 system prompt 补充说明。

### 3. 衰减是按需的，不是自动的

`StructuredMemory` 不运行后台定时任务。Episodic 条目在概念上 7 天过期，但
直到你调用 `memory.decay()` 或读取时的访问时间门控触发前，它们都会留在存储中。
如果存储成本很重要，定期调度 `decay()`。

### 4. `ObservationalMemory` 会运行一个额外的模型

廉价观察者模型（通常是 Haiku 或本地 0.5B 模型）是一次**独立的 API 调用**，
有自己的延迟和成本。总 token 数会上升，即使上下文 token 数下降。
当 agent 运行较长（>10 步）且观察者比主模型便宜得多时，净成本是划算的——
见 [observational-memory.md](./observational-memory.md) 中的数学推导。

### 5. 跨 session 状态是应用的责任

wasmagent-js 提供存储原语；它**不**提供"用户模型"或"人设快照"。
Mem0 和 Letta 在产品层提供这些，因为它们是领域特定的
（CRM 形态 vs 编码助手形态 vs 消费聊天形态）。
如果你想要自动提取的用户档案，在你的应用中编写提取器——
或在 wasmagent 旁边采用 Mem0（它们可以干净地分层：Mem0 拥有用户事实，
wasmagent 拥有 agent 循环）。

## 评估记忆

wasmagent-js 在
[`@wasmagent/evals-runner`](../../packages/evals-runner/) 中提供两个与记忆相关的评估套件：

- **`multi-turn-memory`**（54 个项目，6 个类别）—— 测试跨噪声轮次的召回；
  匹配 LongMemEval 的类别结构
- **`long-context-recall`** —— 在约 16K token 上下文中，分别在 10% / 50% / 90% 深度进行针尖大海捞针测试

2026 年社区基准（LoCoMo-Refined、MemoryAgentBench），
参见 `docs/reports/memory-eval-*.md` 系列。

## 参考页面

- [memory-patterns.md](./memory-patterns.md) — `StructuredMemory`、`createMemoryTool`、`HybridRetriever`、衰减策略
- [observational-memory.md](./observational-memory.md) — 廉价观察者架构的适用场景，成本权衡的数学
- [`MemoryBlocks.ts`](../../packages/core/src/memory/MemoryBlocks.ts) — `MemoryBlockSet` 和 `coreMemoryTools()` 的源码
- [`MessageAssembler.ts`](../../packages/core/src/memory/MessageAssembler.ts) — 带有 B1/B2 缓存规则和 `memoryBlocks` 插槽的 assembler
- [`Checkpointer`](../../packages/core/src/checkpoint/index.ts) — 暂停/恢复合约

## 刻意未实现的内容

我们没有实现 Zep / Graphiti 的双时态实体图谱（`valid_at` / `invalid_at` 事实失效、
增量图更新）。那是 Zep 的产品；如果你需要它，在 wasmagent 旁边运行 Zep，
并让 agent 通过 MCP 调用 Graphiti。对于 80% 的 agent 工作负载——代码助手、
客服机器人、研究 agent——上述七个原语已经足够。
