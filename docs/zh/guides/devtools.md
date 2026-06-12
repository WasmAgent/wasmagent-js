# DevTools — 事件时间线 & 时间旅行调试

> **A2** — 检查 agent 执行轨迹、从任意一步分叉重跑的 UI。基于 agentkit-js 已有的 [`EventLog`](../../packages/core/src/streaming/EventLog.ts) + [`KvCheckpointer`](../../packages/core/src/checkpoint/index.ts) 持久化能力构建。无需新存储 — 数据本来就在那里，DevTools 是把它变成"人能用"的消费者。

## 提供的能力

- **事件时间线** — 每个 `LoggedEvent` 按提交顺序展示。
- **步导航** — 点击第 N 步，光标显示截至该点的所有内容。"final answer" 和"前缀事件列表"实时更新。
- **任意步分叉** — 选一步、可选覆盖 task / model id，从该前缀重跑。组件通过 `onFork` 回调把意图交给宿主页面，**实际启动新 agent run** 由宿主负责。
- **纯逻辑核心** — `EventLogReplay` 是纯 TypeScript。服务端 fork CLI 和测试不需要 React 也能用。

## 两条 import 路径

```ts
// 纯逻辑 — 无 React。
import { EventLogReplay } from "@agentkit-js/devtools";

// React UI — 可选。
import { DevTools } from "@agentkit-js/devtools/react";
```

React 子路径标为可选 peer dep，无 React 用户不背包体积。

## 快速上手

```tsx
import { DevTools } from "@agentkit-js/devtools/react";

function DebugPanel({ events, onFork }) {
  return (
    <DevTools
      events={events}
      traceId="run-abc-123"
      onFork={async (fork) => {
        // 用 `fork.prefixEvents` 启动新 agent run。
        await fetch("/run", {
          method: "POST",
          body: JSON.stringify({
            task: fork.meta.task ?? originalTask,
            modelId: fork.meta.modelId,
            // 把前缀重放进新 run 的 MessageAssembler。
            replayEvents: fork.prefixEvents,
          }),
        });
      }}
    />
  );
}
```

## 加载事件

两种常见形态：

**1. 从 `EventLog.replay()`**（服务端或 CF Worker）：

```ts
import { EventLog } from "@agentkit-js/core";

const log = new EventLog(kvBackend);
const events: LoggedEvent[] = [];
for await (const ev of log.replay(traceId)) events.push(ev);
```

**2. 从浏览器抓到的 SSE 响应**：tap 与 `useAgentRun` 同样的流，把事件累计成数组。`eventId` 在 SSE 的 `id:` 行里。

## 引擎 API

```ts
const replay = new EventLogReplay(events, { traceId: "run-abc-123" });

replay.eventCount;          // 总事件数
replay.stepCount;           // 不同 step_start 事件数
replay.steps;               // ReadonlyArray<ReplayStep>
replay.select(2);           // ReplayCursor — 截至并含第 2 步的前缀
replay.forkAt(2, {          // 为第 2 步产生 Fork 元数据包
  task: "用 claude-haiku 重做第 3 步",
  modelId: "claude-haiku-4-5",
  note: "排查回归",
});
replay.stepForEventId(id);  // 反查事件 id 所属步号
```

`select(0)` 返回第一个 `step_start` **之前**的事件（如 `run_start`）。`select(stepCount)` 返回完整日志。

## 为什么要有 fork API？

LangGraph Studio 时间旅行调试器最大的 UX 卖点是"回到第 N 步、改点东西、再跑一次"。agentkit-js 已经有持久化的一半（EventLog 用稳定 id 记录每个事件；KvCheckpointer 每步保存 assembler 状态）。缺的只是一个小巧、与运行时解耦的引擎，能算出"截至第 N 步的前缀"并产出元数据包给新 run。

Fork **不会** mutate 原日志。原 trace 保持原样；分叉是宿主页面用返回的 `prefixEvents` + `meta` 自己干的事。

## 测试

`packages/devtools/src/EventLogReplay.test.ts` 覆盖 9 个场景，包括零步 trace、越界 cursor 钳位、防御性拷贝、fork 元数据形状。`packages/devtools/src/react/DevTools.test.tsx` 加 8 个 jsdom 渲染测试，覆盖初始 cursor 位置、步导航（`aria-pressed` 切换）、prelude 事件、Fork 面板的 task/model/note 覆盖、空覆盖回落默认值、零步 / 空 trace 边界。跑：`pnpm --filter @agentkit-js/devtools test`。

## 参考

- `packages/devtools/src/EventLogReplay.ts` — 纯重放引擎
- `packages/devtools/src/react/DevTools.tsx` — React UI 组件
- 同时参见：[durable-runtime.md](./durable-runtime.md) — DevTools 所基于的 EventLog + Checkpointer 故事
