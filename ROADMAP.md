# agentkit-js — Roadmap

> Last refreshed: 2026-06-17. Refresh quarterly; keep stamped with the
> last review date so consumers can spot rot.

This roadmap is the public version of the strategic plan that drives the
repo. It is opinionated about what we are NOT going to chase. The
discussion of why each item exists, and what it competes with, lives in
[the strategy memo](docs/strategy/2026-06-competitiveness.md) (added in
the same A6 commit; see also the embedded "Why" lines below).

## Strategic axes (4 lines we steer by)

> **2026-06-17 update.** Five industry shifts since 06-12 (Cloudflare
> portal-default code-mode, OpenAI Agents SDK 2026-04 native sandbox,
> Vercel AI SDK 6 `DurableAgent`, MS Agent Governance Toolkit, OWASP
> Agentic Top 10) tightened the differentiation surface. The axes
> below have been refined; the change log is in
> [`docs/strategy/2026-06-17-update.md`](docs/strategy/2026-06-17-update.md).

- **S1 — Stop competing as a framework. Get embedded as a runtime.**
  The TS-agent-framework race has a winner with 4 orders of magnitude
  more distribution; chasing it is a losing play. **Code-mode is now
  table stakes** (Cloudflare ships it portal-default 2026-03; OpenAI
  Agents SDK has a native sandbox 2026-04; Anthropic standardised the
  pattern). The remaining moat is **portable × multi-language × multi-
  isolation-tier × policy-uniform** — none of the single-vendor sandboxes
  cross all four. agentkit's three-tier kernel matrix (in-process /
  WASM / remote) plus real Pyodide already exists. We ship it as a
  *neutral executor that drops into the framework leaders' existing
  sandbox / executor sockets* (Cloudflare codemode `DynamicWorkerExecutor`,
  OpenAI Agents SDK sandbox provider, Mastra sandbox provider). The
  pitch is "swap the executor, keep your framework."

- **S1' — Be the runtime governance + isolation layer (★ new line).**
  OWASP Agentic Top 10 (2025-12), Colorado AI Act (executable 2026-06),
  EU AI Act high-risk obligations (2026-08), and 75% of enterprises
  putting compliance ahead of capability ([KPMG 2026]) all point at
  the same gap: protocol layers (MCP / A2A) authenticate but
  *delegate authorization to the implementation*. `CapabilityManifest`
  ([`packages/core/src/executor/types.ts`](packages/core/src/executor/types.ts))
  is exactly that primitive — deterministic, framework-neutral,
  runtime-enforced allow-list with real WASM isolation. Coverage map
  in [`docs/security/capability-manifest-owasp.md`](docs/security/capability-manifest-owasp.md).
  Posture: complementary to MS Agent Governance Toolkit (they decide
  *should*, we enforce *can* and isolate the blast radius), not
  competing with it.

- **S2 — Replace self-built numbers with paired-statistical reporting,
  not a single leaderboard headline.** Industry consensus (2026-Q1/Q2):
  agent benchmarks are far less stable than LLM benchmarks — environment
  drift, frozen environments, "self-reported, never independently
  reproduced" headlines, vendors claiming #1 on different datasets.
  Chasing a single LongMemEval number walks into that trust crisis.
  Our angle is *the referee, not the contestant*: `evals-runner`
  (paired McNemar exact / Wilson CI / paired bootstrap, aligned to
  scipy 1e-7; synthetic fixtures with no train/test contamination;
  CI-gated reproducibility; multi-axis Pareto). Target benchmarks:
  **BEAM (ICLR 2026, 1M–10M token, 2,000 questions)** as the new
  frontier in addition to LongMemEval-500. Showcase: the three-round
  arm-f vs bare vs batch-grammar ablation in
  [`docs/reports/arm-f-vs-bare-2026-06-17/`](docs/reports/arm-f-vs-bare-2026-06-17/)
  and [`docs/reports/arm-batch-grammar-2026-06-17/`](docs/reports/arm-batch-grammar-2026-06-17/)
  — the same harness anyone can re-run.

- **S3 — DevX: a zero-deploy local Studio, not a SaaS.**
  Mastra Studio's metrics tab (cost / token / latency / errors) earns
  its rep. Vercel AI SDK 6 (2026-Q1) added their own DevTools panel
  with 20M+ monthly downloads of distribution behind it. agentkit
  already emits all the data; we add the aggregator + a vanilla HTML
  page served by `agentkit devtools` (A4 — shipped). The differentiator
  collapsed to "no hosting, no account, no telemetry phone-home"
  — narrower but still real.

- **S4 — bscode is a funnel, not a product.**
  bscode (the CF Workers + Next.js demo) drives traffic to
  `npm add @agentkit-js/core`. It only demos already-published
  framework APIs; new generic logic lands in agentkit-js first.
  *Updated demo content (2026-06-17):* the headline scene is now a
  `CapabilityManifest`-blocks-an-OWASP-attack live demo, not "another
  coding agent" — see S1' above.

## Shipped (2026-06)

- **A1 — Code-mode MCP server** (`@agentkit-js/mcp-server` ≥ 0.3).
  Two-tool MCP surface (`docs_search` + `execute_code`) collapses N
  downstream tools behind one in-sandbox dispatch. Pairs with any
  agentkit kernel for unified security policy. Token-savings benchmark
  in CI: code-mode is ≤14% of direct-MCP at N=30 tools, monotonic in N.
  Doc: [`docs/guides/code-mode.md`](docs/guides/code-mode.md).
  *2026-06-17 note:* code-mode itself is now table stakes (Cloudflare
  ships it portal-default; OpenAI Agents SDK has native sandbox;
  Anthropic standardised the pattern). The sustained differentiator
  is **portable-across-runtimes + multi-language + multi-isolation-tier
  + uniform `CapabilityManifest`**, not the token-savings number per
  se. We ship `@agentkit-js/mcp-server` to be *the executor that
  drops into any framework's existing sandbox socket*, not as a
  standalone code-mode product.

- **A1.1 — Unified security policy face.** `CapabilityManifest` now
  carries `env / cpuMs / memoryLimitBytes` alongside the existing
  allowedHosts / allowedReadPaths / allowedWritePaths / extraCapabilities.
  Cross-kernel honouring matrix documented in
  [`packages/core/src/executor/types.ts`](packages/core/src/executor/types.ts).

- **A2 — Vercel AI SDK + Mastra plugin packages.**
  - [`@agentkit-js/aisdk`](packages/aisdk) — `sandboxedJsTool()` and
    `codeModeTool()` factories. AI SDK majors 4–6 supported via
    structural typing.
    - **`agentkitCodemodeExecutor` (shipped 2026-06-17)** — Cloudflare
      codemode `Executor` adapter. Drop any agentkit kernel
      (`QuickJSKernel` / `PyodideKernel` / `RemoteSandboxKernel`) into
      CF codemode's BYO-executor socket; closes the three gaps in CF's
      default `DynamicWorkerExecutor` (platform-binding, JS-only,
      stripped-approval). 10 tests green. Source:
      [`packages/aisdk/src/codemodeExecutor.ts`](packages/aisdk/src/codemodeExecutor.ts).
      Upstream-PR draft (ready to file):
      [`docs/strategy/upstream-prs/cloudflare-codemode-byo-executor.md`](docs/strategy/upstream-prs/cloudflare-codemode-byo-executor.md).
  - [`@agentkit-js/mastra-sandbox`](packages/mastra-sandbox) —
    Mastra sandbox provider contract. Drop-in alternative to Blaxel
    / E2B providers.

- **A4 — devtools as a zero-deploy local Studio.** `RunsAggregator` +
  `agentkit devtools --events-file <ndjson>`. Serves cost / token /
  latency-p95 / error-rate over an inline HTML page. Implementation
  in [`packages/devtools/src/RunsAggregator.ts`](packages/devtools/src/RunsAggregator.ts);
  CLI in [`packages/cli/src/index.ts`](packages/cli/src/index.ts).

- **A5 — `GenericOpenAICompatModel`.** One concrete class for every
  OpenAI-compatible endpoint: Ollama, OpenRouter, AI Gateway, Together,
  Groq, Fireworks, DeepSeek, etc. Recipes in
  [`docs/guides/openai-compat-recipes.md`](docs/guides/openai-compat-recipes.md).
  Existing `model-*` packages remain as named presets.

- **A6 — Maintainership signals.** ROADMAP (this file), CONTRIBUTING
  (added 2026-06-12), kernel sandbox-escape SLA in SECURITY.md.

- **Evaluation harness** (`@agentkit-js/evals-runner`, 2026-06-12).
  Multi-model × multi-suite × multi-seed Pareto reports over
  (accuracy, cost, p95 wall). Six reference benchmark suites
  (multi-turn-memory, long-context-recall, cost-per-correct,
  tool-sequence, agent-trajectory, latency-under-budget). Built-in
  paired statistics — McNemar exact / Wilson CI / paired bootstrap /
  G1 gate — match scipy reference values to ±1e-7 across 31 parity
  tests. CLI: `agentkit evals run --suite=<name> --models=<id@url,...>`.
  Doc: [`docs/guides/evals-runner.md`](docs/guides/evals-runner.md).
  All six reference suites use synthetic / hand-built fixtures so
  they don't overlap with public training corpora — a fine-tune on
  GSM8K / MMLU / IFEval cannot silently inflate the score.

- **A3 — LongMemEval-style end-to-end benchmark.** Sample-mode
  harness ([`examples/benchmarks/longmemeval.mjs`](examples/benchmarks/longmemeval.mjs))
  AND a 5-model run against local Ollama
  ([`docs/reports/longmemeval-5model-2026-06-12.md`](docs/reports/longmemeval-5model-2026-06-12.md)).
  Pareto framing surfaced a 0.94 GB Q3_K_M model at parity accuracy
  with the 8B / 12B models at 4× lower p95 latency — exactly the
  insight single-number accuracy benchmarks suppress.

## In flight (2026-Q3)

- **Public LongMemEval-500 run.** The bundled 6-item fixture is a CI
  sanity floor; a full 500-question run against the official
  [LongMemEval](https://github.com/xiaowu0162/LongMemEval) test set
  needs API budget; planned 2026-Q3. Methodology + status:
  [`docs/strategy/leaderboard-plan.md`](docs/strategy/leaderboard-plan.md).

- **SWE-bench-lite-class code-mode dispatch run.** Promoted from
  "considering" → "in flight" 2026-06-12; harness completed
  2026-06-13 — every implementation slot in
  [`examples/benchmarks/swe-bench-lite.mjs`](examples/benchmarks/swe-bench-lite.mjs)
  is now wired (`loadTasks` over the HuggingFace datasets-server
  API, `dispatchCodemode` + `dispatchDirect` end-to-end stub-mode
  paths, `runTests` containerised judge at
  [`examples/benchmarks/judge/`](examples/benchmarks/judge/), and
  `reportPareto` markdown writer). 26-check `--smoke` is the CI
  regression guard. Placeholder report:
  [`docs/reports/swe-bench-lite-pending.md`](docs/reports/swe-bench-lite-pending.md).
  Remaining gates before publication: real-mode (Anthropic /
  OpenAI) answerer wiring + funded API budget. Direction 2 of the
  2026-06-12 optimization brief; comparator Cloudflare Code Mode
  MCP has not published a SWE-bench number, so the first credible
  run owns the citation slot.

## Considering (post-Q3, no commitment)

- **B2 — Cloudflare 2026 platform primitives.** Browser Run backend
  for `tools-browser`, CF Agent Memory as a `KvBackend`, Workflows
  example for long-running checkpoints. Tracks the 2026 Agents Week
  (May) feature set.

## Explicitly NOT on the roadmap

- A new model adapter package per provider. Use
  `GenericOpenAICompatModel` (A5) and contribute a recipe to
  [`docs/guides/openai-compat-recipes.md`](docs/guides/openai-compat-recipes.md).
- A hosted Studio service. Local-only is the design point — see S3.
- A bigger-than-bscode demo product. bscode stays thin; the framework
  is what we ship (S4).

## RFC process

Significant new public-API features land via short PRs against
`docs/rfcs/`. An RFC is one markdown file with three sections:
**Problem**, **Proposed shape**, **Why-not**. Write it before the
implementation PR; review it like normal code.

## How to contribute

See [CONTRIBUTING.md](CONTRIBUTING.md).
