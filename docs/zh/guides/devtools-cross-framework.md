# DevTools — 调试非 wasmagent 框架的 agent

> 本文是 [`devtools.md`](devtools.md) 的配套指南。那篇指南介绍的是
> wasmagent 原生 EventLog 路径。**本指南假设你并未使用 wasmagent-js 作为框架**——
> 你使用的是 Vercel AI SDK、Mastra、OpenAI Agents JS、Anthropic SDK、LangSmith
> 插桩代码，或任何其他能输出 OpenTelemetry GenAI 语义约定 span 的生产方。

`wasmagent devtools --otel-events-file <path>` 读取 NDJSON 或 OTLP/JSON，
将 `gen_ai.*` 属性映射到现有 Studio 视图所消费的事件，并在 `localhost` 上
提供一个独立的 HTML 页面。无需 SaaS、无需账号，数据不离开你的机器。

如果你的 agent 使用了以下某个生产方，你应该能在一分钟内看到现有 trace 的 Studio 视图。

## 前提条件

任选其一：

```bash
# 一次性使用，无需安装：
npx -p @wasmagent/cli wasmagent devtools --otel-events-file ./spans.ndjson

# 或全局安装：
npm install -g @wasmagent/cli
wasmagent devtools --otel-events-file ./spans.ndjson --port 4317
```

此路径**不需要**安装 `@wasmagent/core`。
CLI 会懒加载 devtools 包；GenAI 语义约定适配器是纯数据转换器。

## 采集方案

### Vercel AI SDK 6

`ai-sdk` 在接入 OTel SDK 后会输出 GenAI 语义约定属性。最简捕获方式：

```ts
// instrument.ts（在应用代码之前运行，例如通过 --import 加载）
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";

new NodeSDK({
  // ConsoleSpanExporter 很方便，因为它会将 NDJSON 输出到 stdout——
  // 重定向到文件后可直接传给 `wasmagent devtools`。
  traceExporter: new ConsoleSpanExporter(),
}).start();
```

然后：

```bash
node --import ./instrument.ts your-app.mjs > spans.ndjson
wasmagent devtools --otel-events-file ./spans.ndjson
```

（非调试模式时，将 console exporter 替换为常规的 collector；适配器也能接受 OTel HTTP exporter 写出的 OTLP/JSON。）

### Mastra

Mastra 通过其 OpenInference / OTel 集成输出 GenAI 语义约定。将任意 OTel collector
指向该运行，转储为 NDJSON，适配器会识别标准的 `gen_ai.operation.name` 值
（`invoke_agent`、`chat`、`execute_tool`）。

如果你只有 OpenInference 属性（`llm.*` 而非 `gen_ai.*`），请提 issue 并打上
`devtools:cross-framework` 标签——适配器目前偏向 GenAI semconv，但映射关系是
机械性的，缺失的 key 会补充进来。

### OpenAI Agents JS

`@openai/agents` 的 trace 处理方式相同；工具调用会出现 `gen_ai.tool.name`，
agent 调用会出现 `gen_ai.agent.task`。适配器会对共享同一 `traceId` 的 span
去重，因此 agent→tool→agent 的嵌套调用会被读取为一次完整运行。

### Anthropic SDK 直接调用（无框架）

如果你直接调用 `client.messages.create({...})`，SDK 的 OTel 插桩同样会输出
GenAI 语义约定属性。适配器将此视为单步运行，同一 trace 中的多次调用仍会
聚合显示 cost / token / latency-p95 / 错误率。

### LangSmith 插桩代码

LangSmith 导出支持 OTel 兼容格式，其属性能够干净地映射到 GenAI semconv。
运行该导出后传给适配器，即可在本地获得 Studio 视图，无需 LangSmith 账号。

## Studio 展示内容

页面加载后：

- **运行聚合**。按 trace 展示 cost / token / latency-p95 / 错误率，可排序。
  适合定位"哪些运行在烧预算"。
- **步骤回放**。点击任意 trace，按提交顺序查看逐步事件，并提供与 wasmagent
  原生视图相同的"从某步分叉"操作。
- **并排对比**。在两个不同端口运行两个 devtools 会话，分别加载两个 NDJSON 文件，
  对 wasmagent 原型与现有 Vercel AI SDK / Mastra 实现进行 A/B 对比。这是我们
  推荐的评估是否迁移某个组件的方法。

## 局限性

- **尽力映射**。如果生产方省略了标准属性，适配器仍会展示该 span，但细节减少
  （cost / token 列可能为空）。比较来自不同生产方的两次运行正是这一功能的
  使用场景——过于严格会让这种比较变得不可能。
- **暂无 collector 模式**。目前 CLI 只接受静态文件。OTLP receiver 模式
  （从运行中的 collector 实时接收）计划在 1.0 后考虑；如有需求，请提 issue
  并打上 `devtools:live-ingest` 标签。

## 反馈渠道

- 生产方未被识别 → 提 issue 并打上 `devtools:cross-framework` 标签，附上经过脱敏的 span 样本。
- 特定属性缺失 → 同一标签。
- 建议新增某个生产方的采集方案 → 欢迎提 PR。

本页的出发点是：你不需要是 wasmagent-js 用户也能使用 Studio。跨框架问题
优先处理，因为这正是该包在
[`docs/strategy/maintenance-tiers.md`](/strategy/maintenance-tiers.md)
中定位的目标受众（`@wasmagent/devtools` 是 ◆ Narrative 层级）。
