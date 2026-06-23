# Code Mode — 将 30+ 个 MCP 工具收拢为一个安全的 `execute_code`

> **状态**: 已在 `@wasmagent/mcp-server@0.3`（S1/A1，2026-06）发布。
> 其设计参考了 2026 年多个项目独立汇聚的同一模式：Cloudflare 的 Code Mode MCP server（InfoQ，
> 2026-04）、Red Hat codemode-lite（next.redhat.com，2026-04），以及 Anthropic 的
> "code execution with MCP" 指南。

## 为什么需要 code-mode

当 MCP 宿主（Claude Code、Cursor、Copilot……）连接到一个发布了 30+ 个工具的服务时，每个工具的名称、描述和 JSON schema 都会进入模型的 prompt——即使模型从来不会调用其中大部分工具。Codemode-lite 实测，仅凭将这些工具收拢到一个 `run_python` 入口、并让模型按需 JIT 获取文档，就能节省 **53% 的 token**。

wasmagent-js 的 code-mode 把那个单一的 `run_python`（仅 Red Hat 在自己的 gVisor 容器内运行）替换为**任意 wasmagent `Kernel`**——`QuickJSKernel`、`PyodideKernel`、`WasmtimeKernel` 或 `RemoteSandboxKernel`。同一套 `CapabilityManifest`（allowedHosts / allowedReadPaths / allowedWritePaths / env / cpuMs / memoryLimitBytes）在任何语言和隔离层级上的沙箱行为完全一致。

## 你要交付的代码

```ts
import { JsKernel, ToolRegistry } from "@wasmagent/core";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { createCodeModeServer, createFetchHandler } from "@wasmagent/mcp-server";

const tools = new ToolRegistry();
tools.register({ name: "search_docs", /* … */ });
tools.register({ name: "read_file", /* … */ });
// …还有 40 个工具…

const server = createCodeModeServer({
  serverInfo: { name: "my-code-mode", version: "1.0.0" },
  tools,
  // QuickJSKernel 适合 edge 安全执行；需要完整进程隔离时
  // 可换用 RemoteSandboxKernel（E2B / Cloudflare Sandbox）。
  kernel: new QuickJSKernel({ timeoutMs: 5_000 }),
  capabilities: {
    allowedHosts: ["api.example.com"],
    allowedReadPaths: ["/workspace"],
    cpuMs: 5_000,
    memoryLimitBytes: 64 * 1024 * 1024,
    env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "" },
  },
});

// 挂载到 HTTP——兼容 Node、Bun、Workers。
export default { fetch: createFetchHandler(server, { path: "/mcp" }) };
```

宿主现在只看到**两个**工具，而不是四十个：

- `docs_search(query?, names?)` — JIT 按需拉取下游工具的类型签名和描述。默认不包含 input schema；传入 `includeSchemas: true` 可将其内联。
- `execute_code({ code })` — 在 kernel 中运行一段 JS 代码片段。片段可以通过 `callTool(name, args)` 调用任意已注册工具；只有片段的最终返回值会通过网络传输。

## Token 数学

以下数据来自 `examples/benchmarks/code-mode-tokens.mjs`（离线计量模型，2026-06）：

| 工具数量 N | 直接 MCP | Code-mode | 比率 | 节省 |
| ------: | ---------: | --------: | ----: | ------: |
|      10 |       1530 |       474 | 31.0% |   69.0% |
|      30 |       3490 |       474 | 13.6% |   86.4% |
|     100 |      10350 |       474 |  4.6% |   95.4% |

具体数字取决于你的工具 docstring 长度和宿主的前缀缓存命中率。**规律**才是重点：直接 MCP 的启动开销是 O(N)，code-mode 是 O(1)。

## 安全策略接口

每个 kernel 都遵循同一套 `CapabilityManifest`。矩阵
（[core.executor.types.ts](../../packages/core/src/executor/types.ts)）记录了
各字段在每个 kernel 中是原生强制执行还是尽力而为：

|              字段 |     JsKernel | QuickJSKernel | PyodideKernel | WasmtimeKernel |     Remote |
| -----------------: | -----------: | ------------: | ------------: | -------------: | ---------: |
|       allowedHosts |            ✅ |             ✅ |             ✅ |              ✅ |          ✅ |
|   allowedReadPaths |            ✅ |       ✅ (fs†) |       ✅ (fs†) |        ✅ (fs†) |          ✅ |
|  allowedWritePaths |            ✅ |       ✅ (fs†) |       ✅ (fs†) |        ✅ (fs†) |          ✅ |
|                env |            ✅ |             ✅ |             ✅ |              ✅ |          ✅ |
|              cpuMs | ✅ (timeout) | ✅ (deadline) | ✅ (deadline) |   ✅ (deadline) | ✅ (per-call) |
|   memoryLimitBytes |       ⚠️ best |             ✅ |        ⚠️ best |              ✅ |          ✅ |

† WASM kernel 中的 FS 访问通过显式 `__fs__` 桥接落到宿主，每次调用都会重新对照同一份白名单进行校验。

## 什么时候不该用 code-mode

- **工具数量 < ~10**：启动阶段节省的 token 太少，不值得承担 JIT 文档的往返延迟。直接用 MCP 即可。
- **工具返回值是富对象且你希望模型直接看到原始内容**：在 code-mode 中，模型只能看到 `execute_code` 的最终返回值，因此"先看这个对象，再决定"的多步工作流可能比工具/结果链更难引导。有时 PTC（`ProgrammaticOrchestrator`）更合适——思路相同，但脚本本身就是 agent 的主循环，而不是众多工具之一。
- **你已经在为工具/结果往返付费，因为你需要让模型看到历史记录**：code-mode 会隐藏中间步骤。

## 参见

- [`packages/mcp-server/src/codeMode.ts`](../../packages/mcp-server/src/codeMode.ts)
  — 实现，约 250 行代码。
- [`examples/benchmarks/code-mode-tokens.mjs`](../../examples/benchmarks/code-mode-tokens.mjs)
  — token 计量测试框架；报告汇总到 `report-code-mode.md`。
- [`packages/core/src/executor/ProgrammaticOrchestrator.ts`](../../packages/core/src/executor/ProgrammaticOrchestrator.ts)
  — code-mode 委托的内核脚本执行器。
