# 观察记忆（Observational Memory）

> **A1** — 一次性 `MessageAssembler.compact()` 的"持续观察"替代品。一个便宜的"观察者"模型在后台把长历史压缩成排好序的观察段落；主 agent 继续用它的贵模型跑，上下文保持有界且对 prompt-cache 友好。

## 提供的能力

- **5–40× 压缩**，与 Mastra 的 Observational Memory 相当（LongMemEval 94.87% 参考；我们不自报数字 — 暴露 primitive 并提供你可以跑的 benchmark）。
- **便宜观察者 + 贵 agent** — 观察者跑在小模型（Haiku、豆包、DeepSeek）上。Agent 保持你设的模型。agentkit 的多模型层让这是一行配置。
- **prompt-cache 感知** — 压缩观察落在 assembler 前部，使前缀字节级稳定，后续 agent 调用一直走 cache。这是没有 `cache_control` 意识的厂商打不到的角度。
- **异步 + 非阻塞** — `noteStep()` 调度一次扫描后立即返回。Agent 从不等压缩。
- **持久化** — 绑定 `KvBackend` 时，观察存于 `obs:<sessionId>:<seqId>`，worker 回收后仍然存活。

## 快速上手

```ts
import {
  MessageAssembler,
  ObservationalMemory,
  MapKvBackend,
} from "@wasmagent/core";

const assembler = new MessageAssembler({
  systemPrompt,
  toolsSchema,
  chunkSizeSteps: 5,
  systemPrefixTtl: "1h",
});

const memory = new ObservationalMemory({
  assembler,
  model: agentModel,           // Sonnet / Opus
  observerModel: cheapModel,   // Haiku / 豆包
  sessionId: req.sessionId,
  kv: kvBackend,               // 可选；缺省 in-memory
  tokenThreshold: 6000,
  keepRecentSteps: 5,
});

for await (const event of agent.run(task, traceId)) {
  // …处理事件…
  if (event.event === "step_end") memory.noteStep();
}
await memory.flush();           // 等待任何 in-flight 观察完成
const observations = await memory.list();
```

## 观察的形状

```ts
interface Observation {
  seqId: number;                    // 会话内单调递增的 id
  createdAtMs: number;
  text: string;                     // 单段摘要
  priority: "high" | "medium" | "low";
  coversSteps: { from: number; to: number };
}
```

观察者被要求产出 `{ priority, text }` 形状的 JSON。如果模型忽略契约（有时会，尤其小模型），parser 降级为 `"low"` 优先级的观察，文本是模型原始输出。**稳健性优于严格性**。

## 何时用它 vs `compact()`

- **用 `compact()`** 当你想在已知点做一次性摘要（如长步骤前、或用户显式命令）。它阻塞到完成。
- **用 `ObservationalMemory`** 当对话可能跑一阵子、你想要后台持续压缩。配自动触发器（每步后 `noteStep()`），然后忘掉它。

两者不互斥 — 你可以持续跑观察者 AND 在敏感操作前显式 `compact()`。

## 为什么单独一个类而不是塞进 MessageAssembler？

`MessageAssembler` 是缓存友好的前缀构建器。压缩是策略选择（哪个观察者模型？何时触发？持久化到哪？），不是所有消费者都想要。拆开让 assembler 保持小巧，需要时再独立选用观察对象。

## 参考

- `packages/core/src/memory/ObservationalMemory.ts`
- `packages/core/src/memory/ObservationalMemory.test.ts` — 7 个单元测试覆盖 threshold 触发、观察者 override、错误捕获、KV 镜像、滑动 `coversSteps`、并发触发空操作。
- 同时参见：[memory-patterns.md](./memory-patterns.md)
