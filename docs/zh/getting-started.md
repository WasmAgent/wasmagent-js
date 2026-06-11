# 5 分钟上手 agentkit-js

这份文档把你从零带到第一个跑起来的 Agent，配套的英文版在 [getting-started](../guides/getting-started.md)。

## 1. 安装

```bash
npm install @agentkit-js/core @anthropic-ai/sdk
# 或者用 Bun / pnpm
bun add @agentkit-js/core @anthropic-ai/sdk
```

> 用国产模型？换成对应的适配器：
> `@agentkit-js/model-doubao`（豆包）、`@agentkit-js/model-deepseek`（DeepSeek）、
> `@agentkit-js/model-moonshot`（Kimi）、`@agentkit-js/model-qwen`（通义千问）、
> `@agentkit-js/model-zhipu`（智谱 GLM）、`@agentkit-js/model-minimax`（MiniMax）。
>
> ⚠️ **合规提示**：使用国产模型前请阅读各家服务条款，确认数据出境与存储策略符合你的合规要求。

## 2. 设置密钥

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # 或者 DOUBAO_API_KEY、DEEPSEEK_API_KEY 等
```

## 3. 写 Agent

```ts
// hello-agent.ts
import { CodeAgent, AnthropicModel, AnthropicModels } from "@agentkit-js/core";

const agent = new CodeAgent({
  model: new AnthropicModel(AnthropicModels.SONNET_4_6, {
    apiKey: process.env.ANTHROPIC_API_KEY!,
  }),
});

const result = await agent.run({ task: "12 乘以 13 等于多少？" });
console.log(result.finalAnswer); // → 156
```

或者用豆包（Doubao Seed 1.6）：

```ts
import { CodeAgent } from "@agentkit-js/core";
import { DoubaoModel, DoubaoModels } from "@agentkit-js/model-doubao";

const agent = new CodeAgent({
  model: new DoubaoModel(DoubaoModels.DOUBAO_SEED_1_6, {
    apiKey: process.env.DOUBAO_API_KEY!,
    thinking: { mode: "enabled", effort: "high" },
  }),
});
```

## 4. 跑

```bash
bun run hello-agent.ts
# 或者：npx tsx hello-agent.ts
```

Agent 会决定写一段 `12 * 13` 在默认的 `VmKernel` 里跑出答案，把 `finalAnswer` 流回来。

## 5. 部署到 Cloudflare Workers

`VmKernel` 用的是 `node:vm`，不能在 Workers 跑。换成 QuickJS WASM：

```ts
import { CodeAgent } from "@agentkit-js/core";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";

const agent = new CodeAgent({
  model: /* … */,
  kernel: new QuickJSKernel(),  // 边缘安全的 WASM 沙箱
});
```

完整对比与决策树见 [kernel comparison](../kernels/comparison.md)。

## 接下来

- [Durable runtime](../guides/durable-runtime.md) — checkpoint、SSE 断线重连、Stateless HITL
- [Skills & lifecycle hooks](../guides/skills-and-hooks.md) — 工具懒加载、post-tool 钩子（−85% token）
- [DevTools](../guides/devtools.md) — 时间旅行调试器
- [Evals cookbook](../guides/evals-cookbook.md) — 16 个内置打分器、多准则评委

遇到问题可以 [提 issue](https://github.com/telleroutlook/agentkit-js/issues) — 5 分钟内卡住就是我们要修的 bug。
