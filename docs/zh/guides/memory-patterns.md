# Memory 模式指南

wasmagent 提供三种 memory 基本能力，互相配合很好：
- **向量检索**（semantic + BM25 混合）：[`HybridRetriever`](../../packages/core/src/memory/HybridRetriever.ts)
- **带 TTL & decay 的结构化键值 memory**：[`StructuredMemory`](../../packages/core/src/memory/StructuredMemory.ts)
- **跨会话持久 memory 工具**（让 agent 自己调用）：[`createMemoryTool`](../../packages/core/src/memory/MemoryTool.ts)

本指南解释何时用哪一种，以及如何组合。

---

## Memory 分类

`StructuredMemory` 区分三个命名空间，各有不同的留存语义：

| 命名空间 | 默认 TTL | 用途 | 例子 |
|-----------|-------------|---------|----------|
| `episodic` | 7 天 | 最近事件、观察 | "用户昨天问了 React 19" |
| `semantic` | 永久 | 稳定事实 | "用户的 API key 在环境变量 X" |
| `procedural` | 30 天 | how-to / 技能 memory | "部署 Worker 跑 `bun run deploy`" |

冷的 episodic 条目（accessCount=0 且 >30 天）在 `decay()` 时也会被清理，无论 TTL。

```ts
import { StructuredMemory, InMemoryStructuredKv } from "@wasmagent/core";

const mem = new StructuredMemory(new InMemoryStructuredKv());
await mem.set("user:42", { name: "Alice" }, { namespace: "semantic" });
await mem.set("event:login-2026-06-10", { ip: "..." }, { namespace: "episodic" });
await mem.set("task:deploy", { steps: [...] }, { namespace: "procedural" });

// 定期清理
const result = await mem.decay();
console.log(`清理了 ${result.purged}/${result.scanned} 条`);
```

---

## 跨会话 memory 模式

用 `createMemoryTool` 把 memory 暴露为 agent 可调用的工具。它通过任意 `KvBackend` 读写，因此后端可在内存（dev）和 Cloudflare KV（prod）之间切换。

```ts
import { createMemoryTool, MapKvBackend } from "@wasmagent/core";

const memoryTool = createMemoryTool({
  backend: new MapKvBackend(), // 或者 CF KV 的实现
  namespace: "user:42",        // 按用户隔离
});

const agent = new ToolCallingAgent({
  model,
  tools: [memoryTool, ...otherTools],
});
```

agent 获得四个内置操作：`memory_set`、`memory_get`、`memory_list`、`memory_delete`。

---

## RAG / 检索模式

大语料库的 semantic 召回，用 `HybridRetriever` + dense embedder（`@wasmagent/tools-rag` 的 `HttpEmbedder`）+ 任意向量库：

```ts
import { HybridRetriever, InMemoryVectorStore } from "@wasmagent/core";
import { HttpEmbedder, ragTool } from "@wasmagent/tools-rag";

const embedder = new HttpEmbedder({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "text-embedding-3-small",
});
const dense = new InMemoryVectorStore(embedder);
const hybrid = new HybridRetriever({ dense, bm25Weight: 0.4, semanticWeight: 0.6 });

await hybrid.add("doc-1", "wasmagent 是一个 TypeScript agent 运行时");
// ... 摄入更多文档 ...

const tool = ragTool({ store: hybrid });
// 把 `tool` 传给 ToolCallingAgent
```

BM25 与 dense store 一起自动维护。关键词重的语料（日志、代码）把 `bm25Weight` 调到 0.6 或 0.7。自然语言 Q&A 默认 0.4/0.6 通常赢。

---

## Decay 策略

三种模式：

1. **Lazy**（默认）：TTL 在每次 `get()` 时强制。过期条目返回 null 并悄悄删除。
2. **Active**：定时调用 `mem.decay()`（cron / Cloudflare scheduled handler），批量清理过期和冷条目。让存储有上限。
3. **Audit**：`mem.decay({ dryRun: true })` 报告会清理什么但不删。配额问题排查时有用。

大型 episodic 存储 schedule 每日 active decay。Semantic 事实永久存活 — 别拿它跑 decay，除非你有特殊用例。

---

## 模式组合

一个常见架构：

- **HybridRetriever** 用于 agent 搜索的文档
- **StructuredMemory(semantic)** 存稳定的用户偏好和项目上下文
- **StructuredMemory(episodic)** 存近期观察
- **createMemoryTool** 把 structured memory 包成 agent 可调用工具

各取所长：检索处理"讨论过什么"模糊查询，结构化 memory 做精确查找，tool 包装器让 agent 自己管理上下文。
