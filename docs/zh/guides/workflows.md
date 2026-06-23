# 工作流引擎 — 持久、可恢复、资源感知的 DAG 执行

> *"从长远来看，正确的做法是：一个可移植的工作流引擎，今天在本地运行，
> 明天在 Cloudflare Workflows 上运行，无需重写工作流。"*

## 为什么需要它

wasmagent-js 已经有了基于波次的并行调度器（`Scheduler`）、检查点机制（`KvCheckpointer`）
和事件日志（`EventLog`）。之前缺少的——直到现在——是一个将它们组合成一个**持久、可观测、
可终止、可恢复**的工作单元的单一原语，且能在任何运行时上以相同方式运行。

`WorkflowEngine` 就是这个原语。用户编写一个 `WorkflowDefinition`，然后选择两个引擎之一：

| 引擎 | 运行位置 | 持久化 | 使用场景 |
| --- | --- | --- | --- |
| `LocalWorkflowEngine` | Node、Bun、Edge、浏览器 | 任意 `KvBackend`（内存 / fs / Redis / CF KV / Durable Object） | 想要可移植的运行时，无 Cloudflare 锁定，完全控制宿主进程。 |
| `CloudflareWorkflowEngine` | Cloudflare Workers | 原生 CF Workflows 存储（如需统一可观测性，可镜像到 KvBackend） | 想让平台免费处理休眠、重放、重试和长达 1 年的睡眠。 |

两个引擎每次都满足**相同的四个契约**：

1. **可观测** — 每步都有类型化的事件流和持久化记录。
2. **可终止** — `run.cancel()` 在每个 yield 点都会被响应。
3. **可恢复** — `engine.resume(runId)` 从最后一个完成的步骤恢复。
4. **清晰的错误** — `WorkflowError` 携带 `code`、`runId`、`stepId`、`attempts`、`cause`。

## 快速上手

```ts
import {
  LocalWorkflowEngine,
  KvWorkflowStateStore,
  MemoryKvBackend,
  ToolRegistry,
  type WorkflowDefinition,
} from "@wasmagent/core";

const tools = new ToolRegistry();
tools.register({ /* echo, fetch, summarise, … */ });

const engine = new LocalWorkflowEngine({ tools });

const def: WorkflowDefinition = {
  id: "research",
  steps: [
    { id: "fetch", toolName: "fetch_pages", args: { urls: [...] }, dependsOn: [],
      // 在此运行和共享同一引擎池的其他运行中，限制并发网络调用：
      // 只对你真正想要门控的资源调用 configure()。
      resourceClaims: [{ key: "net", weight: 1 }] },
    { id: "summarise", toolName: "summarise",
      args: { docs: "$fetch" }, dependsOn: ["fetch"],
      retries: { limit: 3, backoff: "exponential" },
      timeoutMs: 30_000 },
    { id: "review", toolName: "review",
      args: { draft: "$summarise" }, dependsOn: ["summarise"] },
  ],
};

const run = await engine.start(def, { params: { topic: "agent loops" } });

// 1. 观测
for await (const ev of run.events()) {
  console.log(ev);
  // → { type: "run_start", runId }
  //   { type: "step_start", stepId: "fetch", attempt: 1 }
  //   { type: "step_complete", stepId: "fetch", result: [...] }
  //   { type: "step_resource_wait", stepId: "summarise", claims: [...] }
  //   { type: "step_complete", ... }
  //   { type: "run_complete", output: { review: "…" } }
}

// 2. 终止
run.cancel("user-stop");      // 协作式；进行中的工具看到 signal.aborted

// 3. 恢复（进程崩溃后，同一个 store 看到已完成的步骤并跳过它们）
const sameRun = await engine.resume(run.runId);

// 4. 清晰的错误
const final = await run.wait();
if (final.status === "failed") {
  // final.error 是 JSON 序列化的 WorkflowError：{ code, runId, stepId, attempts, cause }
}
```

## 可移植性 — 相同的定义，两种引擎

从本地切换到 Cloudflare，你的 `WorkflowDefinition` **无需任何改动**。
CF 适配器将每个步骤转换为 `WorkflowEntrypoint.run()` 主体中对应的
`step.do` / `step.sleep` / `step.waitForEvent` 调用。

```ts
// Cloudflare 侧——单行入口：
import { runWorkflowEntrypoint } from "@wasmagent/cloudflare-worker";

export class ResearchWf extends WorkflowEntrypoint<Env, Params> {
  async run(event, step) {
    return runWorkflowEntrypoint(event, step, definition, {
      resolveTool: ({ step: s, args }) => env.TOOLS.call(s.toolName, args),
      store: new KvWorkflowStateStore(new CloudflareKvBackend(env.WF_STATE)),
    });
  }
}

// 应用侧——驱动工作流的方式与本地引擎完全相同：
const engine = new CloudflareWorkflowEngine({
  binding: env.RESEARCH_WF,
  store:   new KvWorkflowStateStore(new CloudflareKvBackend(env.WF_STATE)),
});
const run = await engine.start(definition, { params });
for await (const ev of run.events()) console.log(ev); // 相同的事件类型
```

共享的 `WorkflowStateStore` 意味着外部观察者（状态仪表板、Slack 通知、审计日志）
无论哪个引擎产生的 KV 记录都能访问。

## 资源语义 — 用户心理模型

> *"如果步骤是串行的，就不存在资源竞争。"*

这正是引擎的行为。`ResourcePool` 默认容量为 `Infinity`。只要有空闲容量，
acquire 就走快速路径，因此即使每个步骤都声明相同的 key，串行链的开销也为零：

```ts
const pool = new InMemoryResourcePool();
pool.configure("openai", { capacity: 5 });   // 限制并发 OpenAI 调用

// 串行链——耗时 3 × stepTime，无等待者。
[ "a", "b", "c" ].forEach((id, i) => steps.push({
  id, toolName: "complete", args: {...},
  dependsOn: i === 0 ? [] : [steps[i-1].id],
  resourceClaims: [{ key: "openai" }],
}));

// 并行兄弟——上限为 5；第六个阻塞直到有一个释放。
for (let i = 0; i < 10; i++) steps.push({
  id: `parallel-${i}`, toolName: "complete", args: {...},
  dependsOn: [], resourceClaims: [{ key: "openai" }],
});
```

只对真正有全局上限的资源（GPU 槽位、API 配额、沙箱进程）配置资源池。
其他所有资源保持无上限且零成本。

## 持久化与崩溃恢复

每次步骤转换在下一个步骤运行**之前**都会写入 `WorkflowStateStore`。
store 以 `runId` 为键，因此新进程可以调用 `engine.resume(runId)`，引擎将会：

1. 重新加载运行记录 + 定义 + 所有步骤记录。
2. 将已完成步骤的结果重放到工作集中（不重新执行）。
3. 将任何处于 `running` 状态的步骤（上一个进程在执行中途崩溃）视为未尝试——
   如果步骤是 `idempotent: true`（默认值），则从尝试 1 重新运行；否则快速失败。
4. 从第一个未完成的步骤继续执行。

持久化层是对 `KvBackend` 的薄封装，因此：

| `KvBackend` | 存储位置 | 适用场景 |
| --- | --- | --- |
| `MemoryKvBackend` | 仅 RAM | 测试、单进程一次性运行 |
| FS（宿主提供） | 本地文件系统 | 单机崩溃恢复 |
| `RedisKvBackend` | Redis | 多 worker 集群、扇出协调 |
| `CloudflareKvBackend` | Cloudflare Workers KV | 最终一致性的 Workers / Pages |
| `DurableObjectKvBackend` | Cloudflare Durable Object 存储 | 强一致性的 Workers |

## 取消 — 每个 yield 点都会响应

工作流运行在每个异步边界都可以取消：

- 在波次之间（每次循环迭代开始时检查 `signal.aborted`）。
- 在 `ResourcePool.acquire` 内（等待者在 signal 中止时拒绝）。
- 在 `ToolRegistry.call` 内（signal 被转发，`fetch` 等操作可以中止）。
- 在重试退避睡眠和延迟步骤轮询中。

`run.cancel(reason)` 同步运行；运行在一个波次迭代内到达 `cancelled` 状态。
已取消的运行是明确**可恢复**的——操作者之后可以选择从同一检查点继续。
（`failed` 运行是终态：重新创建需要一个新的 `runId`。）

## 错误 — 代码优先，方便事后排查

每次失败都以 `WorkflowError` 的形式呈现：

```ts
class WorkflowError extends Error {
  code: WorkflowErrorCode;       // "step_failed" | "step_timeout" | "deadlock" | "cancelled" | …
  runId?: string;
  stepId?: string;
  attempts?: number;
  cause?: unknown;               // 原始错误被保留
  toJSON(): { … };               // 通过 KV / D1 往返传输不变
}
```

持久化的步骤记录存储 `error: describeError(err)`——包含 cause 链的 JSON 安全序列化。
你可以仅凭 KV 就能事后还原任何失败。

## 步骤类型

| `toolName` | 语义 |
| --- | --- |
| 任意已注册工具 | 正常工具调用。在分发前，将 `args` 中的 `$<refId>` 占位符从之前的步骤结果中解析。 |
| `$sleep` | 引擎睡眠 `args.ms` 并持久化 `wakeAt`。跨崩溃可恢复——引擎在恢复时重新计算"wakeAt 是否已过？"。 |
| `$waitForEvent` | 引擎阻塞，直到调用 `engine.sendEvent(runId, type, payload)`。存储在同一 KV 命名空间中；恢复时会拾取未投递的事件。 |

## 我们刻意不做的事

- 已发布的 `InMemoryResourcePool` 中**没有跨进程并发限制**。
  接口允许未来的 Redis / Durable Object 后端；内存实现覆盖了 >80% 的用户
  （单 worker / 单 CLI）。按进程配置 `pool.configure(...)`；如果需要集群级限制，换掉后端。
- **工作流 DSL**（YAML、BPMN 等）。DAG *本身*就是 DSL，用 TypeScript 表达，
  带有完整的 IDE 支持和零解析开销。
- **CPU/GPU/RAM 建模**。`resourceClaims` 是建议权重；引擎不采样 OS 计数器。
  如果需要，构建一个在 `acquire()` 时根据探针进行门控的自定义 `ResourcePool`。

## 测试

`packages/core/src/workflow/` 中有 44 个单元 + 集成测试，
`packages/cloudflare-worker/src/CloudflareWorkflowEngine.test.ts` 中有 6 个。覆盖范围包括：

- 分解（串行链、并行兄弟）。
- 资源感知（用户的*"串行不竞争"*断言是一个专用测试，违反时会导致构建失败）。
- 共享同一 store 的两个引擎实例的持久化 + 崩溃恢复。
- 指数退避重试；失败耗尽路径。
- `$sleep` 和 `$waitForEvent`，包括事件在订阅前到达的路径。
- 取消状态转换。
- 定义验证（重复 id、未知依赖、循环依赖）。
- 跨后端 store 一致性（`MemoryKvBackend` 和文件系统 KV 通过相同的测试套件）。

用 `npm test --workspace @wasmagent/core` 和
`npm test --workspace @wasmagent/cloudflare-worker` 运行。
