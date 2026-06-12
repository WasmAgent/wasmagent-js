---
layout: home

hero:
  name: "agentkit-js"
  text: "Edge-native agent runtime"
  tagline: "Three-tier sandboxed code execution · prompt-cache cost control · first-class Chinese model support · ships to Cloudflare Workers."
  actions:
    - theme: brand
      text: Get started
      link: /guides/getting-started
    - theme: alt
      text: Why three sandbox tiers?
      link: /kernels/comparison
    - theme: alt
      text: GitHub
      link: https://github.com/telleroutlook/agentkit-js

features:
  - icon: 🧱
    title: Three-tier code execution
    details: VmKernel (in-process), QuickJS / Pyodide / Wasmtime (true WASM, edge-safe), RemoteSandboxKernel (E2B / CF Sandbox microVMs). Drop-in interchangeable. No other framework ships all three.
    link: /kernels/comparison
    linkText: Decision tree
  - icon: 💸
    title: Prompt-cache cost control
    details: Auto cache breakpoints, 1-hour TTL, per-TTL usage metering. Verified –86% tokens in CI-gated benchmark.
    link: /benchmarks
    linkText: See benchmarks
  - icon: 🇨🇳
    title: Chinese models, first-class
    details: Doubao, DeepSeek, Kimi, Qwen, GLM, MiniMax. Each adapter handles thinking modes + cache strategies + reasoning fields correctly. None of the Western frameworks ship these.
  - icon: ⏪
    title: Time-travel debugger
    details: <code>EventLogReplay</code> + opt-in <code>&lt;DevTools/&gt;</code> React UI. Step replay any agent run, fork from any step. Tiny opt-in package.
    link: /guides/devtools
    linkText: Open guide
  - icon: 🔁
    title: Durable runtime
    details: Checkpoints, SSE Last-Event-ID resume, stateless human-in-the-loop. Backends - CF KV, Durable Objects, Redis, Upstash.
    link: /guides/durable-runtime
    linkText: Architecture
  - icon: 🧪
    title: Honest, CI-gated benchmarks
    details: Every percentage in the README is reproduced in CI - drift outside ±10 % fails the build. No bit-rot.
    link: /benchmarks
    linkText: See the numbers
  - icon: 📊
    title: Pareto-first model evaluation
    details: <code>@agentkit-js/evals-runner</code> ships six benchmark suites and paired statistics (McNemar / Wilson / bootstrap) — multi-model comparisons surface trade-off fronts, not single-number ranks.
    link: /guides/evals-runner
    linkText: Open guide
---

<div style="text-align: center; margin-top: 3rem; opacity: 0.7;">
<small>Apache-2.0 · <a href="https://github.com/telleroutlook/agentkit-js/blob/main/README.md#comparison-with-other-agent-frameworks">vs Vercel AI SDK / Mastra / LangGraph</a></small>
</div>
