# 在 Vercel AI SDK 中使用 wasmagent kernel

wasmagent 的代码执行 kernel（`@wasmagent/kernel-quickjs`、`kernel-pyodide`、`kernel-wasmtime`、`kernel-remote`）**不依赖 wasmagent 的其余部分**。你可以把它们放进任何允许注册自定义工具的 agent 框架 —— 包括 Vercel AI SDK。

本页展示如何把 `QuickJSKernel` 暴露为 Vercel AI SDK 工具，给 AI SDK 提供今天它还没有的 **边缘安全的沙箱化代码执行能力**。

## 为什么要做

Vercel AI SDK 6 有世界级的 React DX、流式 UI primitives、Next.js 模板里的默认位置。它没有的是：在边缘上把模型生成的代码放进真沙箱里跑。`node:vm` 在 Cloudflare Workers 和 Vercel Edge 被禁；OS 级沙箱需要服务器。

`@wasmagent/kernel-quickjs` 在 QuickJS-in-WASM 里跑 JavaScript — 语言级隔离、无 `node:vm`、~2 MB 冷启动。正好填这个缺。

## 安装

```bash
npm install ai @ai-sdk/openai @wasmagent/kernel-quickjs quickjs-emscripten @jitl/quickjs-wasmfile-release-sync zod
```

## 把 kernel 接成工具

```ts
import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { z } from "zod";

const kernel = new QuickJSKernel();

const runJs = tool({
  description:
    "在沙箱里跑一段 JavaScript 表达式。返回最后一个表达式的值。",
  parameters: z.object({
    code: z.string().describe("JavaScript 代码；返回最后一个表达式的值。"),
  }),
  execute: async ({ code }) => {
    const result = await kernel.run(code);
    return { output: result.output, logs: result.logs };
  },
});

const { text } = await generateText({
  model: openai("gpt-4o"),
  tools: { runJs },
  prompt: "用 runJs 工具算第 12 个 Fibonacci 数。",
});

console.log(text);
```

整个集成就是这些。Vercel AI SDK 能跑的地方 —— Workers、Edge、Node —— kernel 都能跑，因为 QuickJS 只是 WASM。

## 你免费获得什么

- **不需要 `node:vm`** — 在 Cloudflare Workers、Vercel Edge、Deno Deploy 都工作。
- **紧隔离** — QuickJS 是独立 VM；沙箱代码碰不到 worker 的全局或环境。
- **能力受控** — 给 `kernel.run(code, capabilities)` 传第二个 [`CapabilityManifest`](https://github.com/WasmAgent/wasmagent-js/blob/main/packages/core/src/executor/types.ts) 参数即可授予或回收特定主机导入。
- **平滑升级到更高隔离层** — 切到 `@wasmagent/kernel-pyodide` 跑 Python、`@wasmagent/kernel-remote` 走 E2B 微 VM，工具包装代码不用改。

## 同时参见

- [Kernel 决策树](/zh/kernels-comparison) — 选对正确的等级
- [`@wasmagent/kernel-quickjs` README](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-quickjs) — 包级文档
- [在 Mastra 中使用 kernel](./integrate-mastra) — Mastra 框架的同样套路
