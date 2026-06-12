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
