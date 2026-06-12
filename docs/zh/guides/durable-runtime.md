# Durable runtime — checkpoint、SSE 续传、HITL

本指南介绍把无状态 agent 循环变成真正"运行时"的三块基本能力：**durable checkpoint（A1）、Last-Event-ID SSE 续传（A2）、人工介入挂起/恢复（A3）**。三者共享同一个 {@link KvBackend} 契约 — 你选好后端（Cloudflare KV、Durable Objects、Redis、内存版），三块能力都用它。

## TL;DR

```ts
import {
  CheckpointableRun,
  EventLog,
  KvCheckpointer,
  resumeFromHuman,
  applyHumanResponse,
  restoreFromSnapshot,
} from "@agentkit-js/core";
import { CloudflareKvBackend } from "@agentkit-js/cloudflare-worker";

// 一个 adapter，三处复用。
const kv = new CloudflareKvBackend(env.MY_KV);

// 1) durable checkpoint
const checkpointer = new KvCheckpointer(kv);
const run = new CheckpointableRun({ checkpointer }, agent.assembler);
for await (const ev of run.run(agent.run(task), task, traceId)) { ... }

// 2) SSE 续传
const log = new EventLog(kv);
for await (const { eventId, event } of log.tap(agent.run(task), traceId)) {
  // 把 `id: ${eventId}\nevent: ${event.event}\ndata: ${...}\n\n` 通过 SSE 发出
}

// 3) HITL 续传（不同进程，几小时后）
const ok = await resumeFromHuman(checkpointer, traceId, promptId, response);
```

## A1 — durable checkpoint

把任意 agent 流用 `CheckpointableRun` 包一下，每一步后自动 checkpoint。崩溃后加载快照从断点继续。

### 后端

| 后端 | 适用场景 |
|---|---|
| `InMemoryCheckpointer` | 测试、本地开发 |
| `KvCheckpointer(new CloudflareKvBackend(env.KV))` | Workers — 最终一致性、多区域 |
| `KvCheckpointer(new DurableObjectKvBackend(state.storage))` | Workers — 强一致、单实例每 run |
| `KvCheckpointer(new RedisKvBackend(client))` | Node/Bun + Redis |
| `KvCheckpointer(new RedisRestKvBackend({url, token}))` | Edge + Upstash REST |

### 重启后续传

```ts
const snap = await checkpointer.load(traceId);
if (snap) {
  restoreFromSnapshot(snap, agent.assembler);
  // 用同一 traceId 续传，未来事件序号才能对齐。
  for await (const ev of run.run(agent.run(snap.task, traceId), snap.task, traceId)) { ... }
}
```

`final_answer` 事件触发时自动 `checkpointer.delete(traceId)`，已完成的 run 不会堆积。

## A2 — SSE Last-Event-ID 续传

长 SSE 流被切断时（网络抖动、worker 回收），客户端用 `Last-Event-ID` 重连，服务端从持久化日志无缝续传，不丢、不重。

### 服务端（Cloudflare Worker）

参考 worker（`packages/cloudflare-worker/src/index.ts`）在你绑定 `AGENTKIT_EVENT_LOG` 后自动做：

```toml
# wrangler.toml
[[kv_namespaces]]
binding = "AGENTKIT_EVENT_LOG"
id = "..."
```

每条响应带 `X-Agentkit-Trace-Id` header。客户端记下它和最大 `id:` 行号即可。

### 客户端（`@agentkit-js/react`）

```tsx
const { messages, run } = useAgentRun("/run", {
  resume: { maxAttempts: 3, delayMs: 1000 },
});
```

hook 重试时会自动带上 `Last-Event-ID`。`maxAttempts: 0`（默认）则保留单次尝试的旧行为。

### 手动 replay

```ts
const log = new EventLog(kv);
for await (const { eventId, event } of log.replay(traceId, lastSeenId)) {
  // emit
}
// 然后继续 tap 实时事件：
const startSeq = await log.nextSeq(traceId);
for await (const { eventId, event } of log.tap(agent.run(task), traceId, { startSeq })) {
  // emit
}
```

## A3 — 人工介入挂起 / 恢复

agent 发出 `await_human_input` 事件时，`CheckpointableRun` 保存包含 `pendingHumanInput` 的快照然后退出迭代器。Worker 可以直接退出 — run 的状态在 KV 里活着，等人来回应。

### 暂停路径

agent 或任意工具 yield：

```ts
yield {
  channel: "status",
  event: "await_human_input",
  data: {
    promptId: "approve-pr",
    prompt: "即将推送 PR #42 — 是否批准？",
    step: currentStep,
  },
} as AgentEvent;
```

`CheckpointableRun.run()` 捕获、保存、返回。HTTP 响应结束；worker 释放。

### 恢复路径

几小时后操作人发起 `POST /resume`（参考 Cloudflare worker 内置）：

```bash
curl -X POST https://your-worker/resume \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"traceId":"...","promptId":"approve-pr","response":"approve"}'
```

这一调用把 response 写进快照。下次有人加载这个快照时，agent 通过：

```ts
const snap = await checkpointer.load(traceId);
restoreFromSnapshot(snap, agent.assembler);
applyHumanResponse(snap, agent.assembler); // 把回应作为 user_message 注入历史
for await (const ev of run.run(agent.run(snap.task, traceId), snap.task, traceId)) { ... }
```

`applyHumanResponse` 把回应作为一步 user_message 加入历史，下一轮模型就能看到。

## 横切验收门

计划要求：
- 三块能力共享 **唯一一个** `KvBackend` 契约 — 不引入并行的 KV 抽象。导出的 `KvBackend`（带可选 `list?(prefix)`）是唯一契约；旧版 `StructuredKvBackend` 是兼容用别名，保留一个大版本。
- HITL 守门高风险工具调用。用 `needsApproval: true` 标记工具，agent 在调用前会发 `await_human_input`。
- 每个新增持久化后端的 PR 都要附带"kill-and-resume"集成测试（参考 `packages/core/src/checkpoint/redis.test.ts` 和 `packages/cloudflare-worker/src/kvAdapters.test.ts` 的形状）。

## 已验证内容

| 声明 | 测试 | 备注 |
|---|---|---|
| 快照跨两个 adapter 实例存活（Redis） | `packages/core/src/checkpoint/redis.test.ts` → "kill and resume" | 两个 REST 客户端共享一个 map；后者读到前者写的内容。 |
| 快照跨两个 adapter 实例存活（CF KV） | `packages/cloudflare-worker/src/kvAdapters.test.ts` → "snapshot survives across adapter instances" | 同上，但用 `CloudflareKvBackend` 配伪 `KVNamespace`。 |
| 快照跨两个 adapter 实例存活（DO storage） | `packages/cloudflare-worker/src/kvAdapters.test.ts` → "DurableObjectKvBackend: snapshot survives" | 强一致性变种。 |
| `Last-Event-ID` replay 不丢不重 | `packages/core/src/streaming/EventLog.test.ts` → "the kill-and-replay round trip is gap- and duplicate-free" | 实时 + 重放的合并序列单调且不重复。 |
| HITL 暂停 / 恢复跨三个进程 | `packages/core/src/checkpoint/hitl.test.ts` → "resumeFromHuman in a fresh process marks the snapshot ready" | 进程 1 暂停掉，进程 2 提交回应，进程 3 加载继续。 |
| bscode 中 `createApp()` 重建后契约不变 | `bscode/apps/worker/src/app.test.ts` → "snapshot saved via one createApp() instance is readable by a fresh instance" | 生产形态 worker，单一共享 `MemKvStore`。 |
