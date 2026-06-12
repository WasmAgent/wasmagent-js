# Changelog

All notable changes to **agentkit-js** are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/).

> **Cadence:** we aim for a release every two weeks; significant fixes
> may ship sooner. Tagged versions on GitHub and npm correspond
> 1-to-1 with sections in this file.
>
> **Frozen API surface:** see
> [`docs/strategy/api-stability.md`](docs/strategy/api-stability.md)
> for which exports are covered by SemVer guarantees. Anything marked
> `@experimental` may change in a minor release.

## [Unreleased]

### Added
- **bscode reverse-funnel page — Direction 6 of the 2026-06-12
  optimization brief.** New page in the bscode demo repo,
  `docs/their-framework-our-kernel.md`, documents five recipes
  for dropping agentkit kernels into the framework the visitor
  already uses (Vercel AI SDK 6 + `sandboxedJsTool`, Cloudflare
  codemode + `agentkitCodemodeExecutor` shim, Mastra +
  `agentkitMastraSandbox`, Anthropic Claude Agent SDK +
  `sandboxedJsClaudeTool`, OpenAI Agents JS +
  `sandboxedJsAgentTool`). Each recipe carries a UTM-tagged
  `?source=bscode-<framework>-recipe` so the strategy memo's
  falsifiability test ("zero organic downloads from upstream
  ecosystems by 2026-Q4 ⇒ retire the runtime pitch") can be
  checked against attribution data, not a hand-wave. The bscode
  README links the page from the "What this demonstrates"
  section so visitors who arrive expecting a framework demo
  see the runtime pitch alongside.
- **Public-benchmark plan + SWE-bench-lite skeleton — Direction 2
  of the 2026-06-12 optimization brief.** New strategy doc
  `docs/strategy/leaderboard-plan.md` lays out the ordered plan
  for trading self-built numbers for public-leaderboard numbers
  on two axes: LongMemEval-500 (defensive, vs Mastra's 94.87%)
  and SWE-bench-lite-class code-mode dispatch (offensive — no
  competitor has published a number on this axis yet, so the
  first credible run owns the citation slot for 6–12 months).
  The SWE-bench-lite harness skeleton lands at
  `examples/benchmarks/swe-bench-lite.mjs` with a `--smoke` CI
  guard and a fully-documented pre-run checklist; the placeholder
  report lives at `docs/reports/swe-bench-lite-pending.md`. ROADMAP
  promotes the SWE-bench-lite run from "considering" to "in flight."
- **Cloudflare codemode third-party-executor draft — Direction 1
  of the 2026-06-12 optimization brief.** New draft
  `docs/strategy/upstream-prs/cloudflare-codemode-byo-executor.md`
  proposes a recipe page in `cloudflare/agents` pointing
  codemode users to `@agentkit-js/kernel-quickjs` /
  `kernel-pyodide` / `kernel-remote` as a community-maintained
  executor that closes the three explicit gaps in the default
  `DynamicWorkerExecutor` (no Workers binding, Python support,
  `needsApproval` lifecycle). Pre-submission gate: ship the
  `agentkitCodemodeExecutor` shim in `@agentkit-js/aisdk` first
  so the example runs. The directory's `README.md` was raised
  from "appendix" framing to "Direction 1 priority" with the
  rationale and a contributor pointer that ties co-maintainer
  candidacy to landing one of these upstream entries.
- **DevTools as standalone framework-agnostic Studio — Direction 5
  of the 2026-06-12 optimization brief.** `packages/devtools/README.md`
  rewritten to lead with the cross-framework story (Vercel AI SDK,
  Mastra, OpenAI Agents JS, Anthropic SDK, LangSmith-instrumented
  code) ahead of the EventLog story. New page
  `docs/guides/devtools-cross-framework.md` provides per-producer
  capture recipes plus a `devtools:cross-framework` issue label
  for prioritizing producers users actually have. The CLI is
  reachable via `npx -p @agentkit-js/cli agentkit devtools
  --otel-events-file <path>` so non-agentkit users do not need
  to install `@agentkit-js/core`. The adapter
  (`convertGenAiSpansToEvents`) was already shipped in 2026-06-12;
  this is the discovery surface upgrade.
- **Maintenance tiers — Direction 4 of the 2026-06-12 optimization
  brief.** `docs/strategy/maintenance-tiers.md` classifies all 33
  packages into ★ Core (8) / ◆ Narrative (15) / ▽ Maintenance-mode
  (10). The ten ▽ packages (`model-deepseek`, `model-doubao`,
  `model-minimax`, `model-moonshot`, `model-qwen`, `model-zhipu`,
  `a2a`, `ag-ui`, `ui-cards`, `ui-cards-react`) carry a
  top-of-README banner stating the dominance reason (six are
  dominated by `GenericOpenAICompatModel` + recipe; the other
  four are off the embedded-runtime thesis path) and a
  `tier:promote-request` issue label so users can flag active use.
  No `package.json` deprecation, no npm dist-tag move — the
  banner is the only behavior change. Falsifiability: ▽ packages
  with neither a promote-request nor sustained > 100 d/w by
  2027-Q1 graduate to "deprecated → archive."
- **Governance signals — Direction 3 of the 2026-06-12 optimization
  brief.** `docs/strategy/api-stability.md` now publishes a
  **2026-12-15 1.0-freeze date** for `@agentkit-js/core`, with a
  six-item gating checklist (co-maintainer, six bi-weekly releases
  without stall, sandbox-escape drill on file, public-benchmark
  number, experimental table reviewed, migration note). Two new
  public ledgers back the existing SLAs:
  `docs/strategy/release-cadence-log.md` (every tagged release
  lands a row; missed fortnights with non-empty `[Unreleased]`
  land a stall row) and `docs/strategy/security-drill-log.md`
  (synthetic P0 finding rehearsal each quarter while maintainer
  count < 3, paging the disclosure path end-to-end). README and
  `GOVERNANCE.md` link both ledgers; `CONTRIBUTING.md` opens with
  a top-level "looking for a co-maintainer" pointer rather than
  burying it in governance.
- `@agentkit-js/claude-agent-sdk` (D1) — agentkit kernels as Claude
  Agent SDK tools. `sandboxedJsClaudeTool()` and `codeModeClaudeTool()`
  emit the Anthropic-shape `{name, description, input_schema, handler}`
  quadruple, structurally typed so they survive both the v0 and the
  upcoming v1 line of `@anthropic-ai/sdk`. 7 unit tests.
- `@agentkit-js/openai-agents` (D1) — agentkit kernels as OpenAI
  Agents JS tools. `sandboxedJsAgentTool()` and `codeModeAgentTool()`
  emit the `@openai/agents` `Tool<T>` shape (Zod parameters +
  `execute()`). 6 unit tests.
- `docs/guides/integrate-claude-agent-sdk.md` and
  `docs/guides/integrate-openai-agents.md` — install + minimal
  snippets + capability cheat-sheet for each adapter, mirroring the
  existing Vercel AI SDK guide.
- `examples/benchmarks/longmemeval-500.mjs` (D2) — standalone runner
  for the official LongMemEval-500 set with multi-observer
  comparison, per-category breakdown (multi-session row called out
  explicitly as the Mastra weak spot), prompt-cache hit accounting
  (Anthropic `cache_read_input_tokens` summed), and a `--smoke` mode
  that exercises the runner offline so CI doesn't drift. The full
  run is funding-dependent (🖥️ in ROADMAP); a placeholder lives at
  `docs/reports/longmemeval-500-pending.md` with the exact CLI
  command that will populate it.
- `agentkit devtools --otel-events-file <path>` (D5) — point the
  zero-deploy local Studio at any GenAI semconv source: NDJSON spans
  or OTLP/JSON. The `convertGenAiSpansToEvents()` adapter (9 tests)
  maps `gen_ai.operation.name = invoke_agent | chat | execute_tool`
  spans to the `LoggedEvent` shape the existing aggregator reads, so
  Vercel AI SDK / Mastra / OpenAI Agents JS / Anthropic SDK traces
  render in the same Studio view as agentkit's own runs.
- `evals-runner` warm-up phase — each model is primed before the
  first eval seed so `p95WallMs` reflects steady-state inference
  rather than cold model loading. `warmupMs` is reported separately.
- `evals-runner/energy` — `estimateJoulesPerCorrect()` and
  `renderEnergyTable()` derive a token-throughput × TDP energy
  estimate; reports can now show J/correct alongside USD/correct.
- `evals-runner` cross-model McNemar comparison rendered in the
  markdown report, with an explicit `NOT-FOR-CLAIMS` watermark when
  n < 50 items or seeds < 3.
- `multi-turn-memory` reference suite expanded from 6 hand-crafted
  items to 54 parametric items across 6 categories (single-session,
  multi-session, knowledge-update, temporal-reasoning, long-context,
  preference-update). Same design philosophy as GSM-Symbolic —
  contamination-resistant by construction.
- `docs/strategy/2026-06-competitiveness.md` — the strategy memo that
  ROADMAP.md has referenced since 2026-06-12 (previously a dangling
  link).

## [0.2.0] — 2026-06-12

First public npm release. Establishes the package set and the four
strategic axes (S1–S4 in ROADMAP.md). All packages share this
version line for the initial publish; subsequent releases will
version per-package via changesets.

### Added
- 30 published packages: `core`, three kernels (`kernel-quickjs`,
  `kernel-pyodide`, `kernel-wasmtime`, plus `kernel-remote`),
  upstream adapters (`aisdk`, `mastra-sandbox`), eight model
  presets, the `mcp-server`, `devtools`, `evals-runner`, and
  supporting tool packages (`tools-browser`, `tools-rag`,
  `tools-web`, `ui-cards`, `ui-cards-react`, `react`, `cli`,
  `cloudflare-worker`, `a2a`, `ag-ui`, `agent-prompts`,
  `otel-exporter`).
- Three-tier code-execution kernel matrix (in-process / WASM /
  remote) with a unified `CapabilityManifest` enforced cross-kernel.
- `ObservationalMemory` with a byte-stable observer prefix designed
  for Anthropic prompt-cache hits.
- Quality Runners: `SelfConsistencyRunner`, `ReflectRefineRunner`,
  `BudgetForcingRunner`, `ParallelForkJoinRunner`.
- Speculative DAG scheduler (`Scheduler` + `SimpleIR` +
  `deriveDependencies`).
- Multi-criteria `JudgeScorer` for LLM-as-judge evals.
- Code-mode MCP server (`@agentkit-js/mcp-server` ≥ 0.3) with a
  two-tool surface (`docs_search` + `execute_code`) shown to use
  ≤14% of the tokens of direct-MCP at N=30 tools.
- Zero-deploy local Studio: `RunsAggregator` + `EventLogReplay` +
  `agentkit devtools` CLI serving an inline HTML dashboard.
- Statistically rigorous evaluation harness (`@agentkit-js/evals-runner`)
  with McNemar exact, Wilson CI, paired bootstrap, six reference
  benchmark suites, and Pareto-front rendering.

[Unreleased]: https://github.com/telleroutlook/agentkit-js/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/telleroutlook/agentkit-js/releases/tag/v0.2.0
