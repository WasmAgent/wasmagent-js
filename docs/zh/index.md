---
layout: home

hero:
  name: "wasmagent"
  text: "边缘原生的 Agent 运行时"
  tagline: "三层沙箱化代码执行 · prompt-cache 成本控制 · 国产模型一等公民 · 一键部署到 Cloudflare Workers。"
  actions:
    - theme: brand
      text: 5 分钟上手
      link: /zh/getting-started
    - theme: alt
      text: 为什么是三层沙箱？
      link: /zh/kernels-comparison
    - theme: alt
      text: GitHub
      link: https://github.com/WasmAgent/wasmagent-js

features:
  - icon: 🧱
    title: 三层代码执行沙箱
    details: VmKernel（进程内）、QuickJS / Pyodide / Wasmtime（真 WASM，边缘安全）、RemoteSandboxKernel（E2B / CF Sandbox 微 VM）。可热插拔。这是市面上唯一同时提供这三层的框架。
    link: /zh/kernels-comparison
    linkText: 选型决策树
  - icon: 💸
    title: prompt-cache 成本控制
    details: 自动缓存断点、1 小时 TTL、按 TTL 区间计量。CI 锁定的基准证实 –86% token。
    link: /zh/benchmarks
    linkText: 看基准数字
  - icon: 🇨🇳
    title: 国产模型一等公民
    details: 豆包、DeepSeek、Kimi、通义千问、智谱 GLM、MiniMax。每个适配器都正确处理思考模式 + 缓存策略 + reasoning 字段。海外框架完全空白。
  - icon: ⏪
    title: 时间旅行调试器
    details: <code>EventLogReplay</code> + 可选 <code>&lt;DevTools/&gt;</code> React 组件。任意 agent run 步进重放，可从任意步分叉。
    link: /zh/guides/devtools
    linkText: 查看指南
  - icon: 🔁
    title: Durable runtime
    details: Checkpoint、SSE Last-Event-ID 续传、stateless human-in-the-loop。后端可选 CF KV / Durable Objects / Redis / Upstash。
    link: /zh/guides/durable-runtime
    linkText: 架构详解
  - icon: 🧪
    title: 诚实可复现的 CI 基准
    details: README 里每一个百分比都在 CI 中复现。漂移超出 ±10 % 直接 fail，不会 bit-rot。
    link: /zh/benchmarks
    linkText: 看数字
  - icon: 📊
    title: Pareto 优先的模型评测
    details: <code>@wasmagent/evals-runner</code> 提供 6 个评测套件 + 配对统计学（McNemar / Wilson / bootstrap）—— 多模型对比直接给出 trade-off 前沿，而不是单一数字排名。
    link: /zh/guides/evals-cookbook
    linkText: 查看指南
---

<div style="text-align: center; margin-top: 3rem; opacity: 0.7;">
<small>Apache-2.0 · <a href="https://github.com/WasmAgent/wasmagent-js/blob/main/README.md#comparison-with-other-agent-frameworks">vs Vercel AI SDK / Mastra / LangGraph</a></small>
</div>
