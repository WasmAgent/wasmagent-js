# 在 Mastra 中使用 agentkit-js kernel

agentkit-js 的代码执行 kernel（`@agentkit-js/kernel-quickjs`、`kernel-pyodide`、`kernel-wasmtime`、`kernel-remote`）独立工作。你可以注册它们作为 [Mastra](https://mastra.ai) 工具 —— 或者任意接受 tool 定义的 agent 框架 —— 而不必引入 agentkit-js 的其余部分。

本页展示如何把 `QuickJSKernel` 暴露为 Mastra 工具。

## 为什么要做

Mastra 提供了出色的 batteries-included DX —— 四层 memory、suspend/resume、evals、MCP 支持。它**没有**的是把沙箱化代码执行作为一等公民。agentkit-js 的 kernel 包补上这个缺口。

## 安装

```bash
npm install @mastra/core @ai-sdk/openai @agentkit-js/kernel-quickjs quickjs-emscripten @jitl/quickjs-wasmfile-release-sync zod
```

## 把 kernel 接成 Mastra 工具

```ts
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { openai } from "@ai-sdk/openai";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";
import { z } from "zod";

const kernel = new QuickJSKernel();

const runJs = createTool({
  id: "runJs",
  description:
    "在 QuickJS WASM 沙箱里跑 JavaScript 表达式。返回最后一个表达式的值。",
  inputSchema: z.object({
    code: z.string(),
  }),
  execute: async ({ context }) => {
    const result = await kernel.run(context.code);
    return { output: result.output, logs: result.logs };
  },
});

const agent = new Agent({
  name: "calculator",
  instructions: "用 runJs 工具算出精确答案。",
  model: openai("gpt-4o"),
  tools: { runJs },
});

const mastra = new Mastra({ agents: { agent } });

const result = await mastra.getAgent("agent").generate(
  "算第 12 个 Fibonacci 数。",
);
console.log(result.text);
```

## 切换隔离层时不用动 agent

各等级 kernel 接口完全一致：

```ts
import { PyodideKernel } from "@agentkit-js/kernel-pyodide";    // 真 CPython
import { WasmtimeKernel } from "@agentkit-js/kernel-wasmtime";  // Javy + WASI
import { RemoteSandboxKernel } from "@agentkit-js/kernel-remote"; // E2B / CF Sandbox
```

替换 tool 定义里的 constructor 即可；Mastra agent 的其余部分不动。

## 同时参见

- [Kernel 决策树](/zh/kernels-comparison) — 选对等级
- [`@agentkit-js/kernel-quickjs` README](https://github.com/telleroutlook/agentkit-js/tree/main/packages/kernel-quickjs)
- [在 Vercel AI SDK 中使用 kernel](./integrate-vercel-ai-sdk) — Vercel AI SDK 的同样套路
