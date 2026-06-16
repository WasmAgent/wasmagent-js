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
- **Kernel `env` capability — full honouring across all WASM tiers
  (2026-06-16).** The `CapabilityManifest.env` field is now actually
  consumed by `PyodideKernel`, `WasmtimeKernel`, and `RemoteSandboxKernel`
  in addition to the long-standing `JsKernel` / `QuickJSKernel` paths.
  Each kernel now exposes the per-call frozen env map as a `__env__`
  global to user code (the canonical name shared across tiers); Pyodide
  additionally clears + repopulates `os.environ` so Python code reading
  `os.environ['KEY']` sees the manifest's env, nothing else. Locked by
  contract tests in each kernel's package: PyodideKernel.test.ts,
  WasmtimeKernel.test.ts (3-call frozen-state assertion),
  RemoteSandboxKernel.test.ts (harness-builder unit tests).
- **Kernel `cpuMs` per-call override — Wasmtime / Remote
  (2026-06-16).** Per-call `capabilities.cpuMs` now takes precedence
  over the constructor-time `opts.timeoutMs` default in
  `WasmtimeKernel` and `RemoteSandboxKernel`. Aligns the two with the
  per-call deadline the JsKernel / QuickJSKernel already honour.
  Pyodide remains advisory (Pyodide is sync-only inside the WASM
  isolate; true cpuMs enforcement requires a worker tier — out of
  scope for this commit). The capability honouring matrix in
  `packages/core/src/executor/types.ts` now reflects reality
  (Pyodide cpuMs ⚠️ advisory; Wasmtime memoryLimitBytes ⚠️ no native).
- **`@agentkit-js/evals-runner` — `multiTurnMemorySuiteOriginal` exposed
  (2026-06-16).** The 6-item original variant of the multi-turn-memory
  suite is now (a) registered in `REFERENCE_SUITES` under the name
  `"multi-turn-memory-original-6"` and (b) re-exported as a named
  symbol from the package barrel. Background: as the LoCoMo-style
  templates expanded the main `multi-turn-memory` suite to 63 items,
  contract / smoke tests that wanted a fixed denominator had nowhere
  to go — the original 6-item variant was defined but unreachable.
  Now both consumption paths work:
    - `import { REFERENCE_SUITES } from "@agentkit-js/evals-runner"`
      and pick `REFERENCE_SUITES["multi-turn-memory-original-6"]`,
    - `import { multiTurnMemorySuiteOriginal } from "@agentkit-js/evals-runner"`
      and use directly.
  Caught by `examples/integration-smoke/edge-evals-runner.mjs` as
  part of the 4-axis audit's full-validation pass.

### Fixed
- **swe-bench-lite container judge — `runTests` slot filled
  (2026-06-13).** The last unfilled slot in `examples/benchmarks/swe-bench-lite.mjs`
  now ships:
  - `examples/benchmarks/judge/Dockerfile` — Python 3.11 + git +
    build essentials (~150 MB image).
  - `examples/benchmarks/judge/judge.py` (~250 lines) — clones the
    task repo at `base_commit`, applies `test_patch` + the agent
    patch, runs pytest per node-id from `fail_to_pass` ∪
    `pass_to_pass`, writes a `result.json` with passed/failed splits.
    `resolved` is true iff applied AND every fail_to_pass passes
    AND every pass_to_pass still passes.
  - `runTests(task, patch, opts?)` in the harness — builds the
    image on first call (or trusts `--skipBuild`), runs
    `docker run --rm -v $tmp:/work agentkit-swe-judge:latest`,
    parses the result back. NEVER touches the host (the brief's
    pre-run-checklist hard gate). On hosts without docker
    (the typical contributor laptop / unprivileged CI runner),
    returns a well-typed result with `error: "docker not available"`
    so smoke / Pareto report scaffolding still works.
  - `.github/workflows/swe-bench-judge.yml` — `workflow_dispatch`-only
    workflow that builds the image, runs the smoke test, then runs
    `examples/benchmarks/judge-roundtrip-ci.mjs` (a 1-task empty-patch
    round-trip that proves docker → judge → result.json end-to-end
    without a model). Cost: $0.
  - `swe-bench-lite.mjs` exports `loadTasks`, `dispatchCodemode`,
    `dispatchDirect`, `runTests`, `reportPareto` for programmatic
    use; the CLI dispatch is now wrapped in an `isMain` guard so
    importing the module does NOT trigger the CLI exit-2 path.
  - `--smoke` is now 26 offline checks (was 19): adds 7 runTests
    shape assertions covering well-typed object, boolean fields,
    array shapes, error-on-no-docker fallback path, wallMs sanity.
- **bscode `/recipes` live route — Direction 6 reverse-funnel
  upgraded from docs to live page (2026-06-13).** The first round
  of Direction 6 shipped only `docs/their-framework-our-kernel.md`
  in the bscode repo. Now `apps/web/src/app/recipes/page.tsx` is
  a clickable Next.js route that shows all five framework recipes
  (Vercel AI SDK 6, Cloudflare codemode, Mastra, Anthropic Claude
  Agent SDK, OpenAI Agents JS) with copy-snippet / copy-npm-install
  / "try a live patch" / "open framework docs" buttons. Live patches
  hit `apps/web/src/app/api/recipes/run/route.ts` (POST handler with
  7 vitest cases). Each upstream link carries
  `?utm_source=bscode-<framework>-recipe` so attribution back to
  agentkit-js is preserved end-to-end. The bscode home page navbar
  gains a purple "their framework + our kernel →" pill alongside
  the existing green "npm add @agentkit-js/core →" pill so the
  reverse-funnel pitch is visible from the very first paint.
  bscode commit
  [`19bc56d`](https://github.com/WasmAgent/bscode/commit/19bc56d).
- **swe-bench-lite harness — `loadTasks` + `dispatchCodemode` (mock-mode)
  landed (2026-06-13).** `examples/benchmarks/swe-bench-lite.mjs` is no
  longer pure skeleton:
  - `loadTasks(count)` fetches from HuggingFace datasets-server
    (`princeton-nlp/SWE-bench_Lite`), pages at 100 rows/call up to the
    full 300, caches to `.cache/swe-bench-lite/test.json`. New
    `--load-tasks=N` flag for live probing. JSON-string-encoded
    `FAIL_TO_PASS` / `PASS_TO_PASS` columns are parsed; defensive
    against missing fields so a single malformed row does not abort
    the load.
  - `dispatchCodemode(task, answerer)` end-to-end through the
    stub-answerer path: spins up `JsKernel` + `agentkitCodemodeExecutor`
    + a fake repo-edit tool surface (`readFile` / `writeFile` /
    `gitDiff` / `runTestsInRepo`), runs the answerer-supplied codemode
    script, returns `{ patch, toolCallCount, error?, logs }`. Real-mode
    Anthropic / OpenAI answerers throw a clear "not wired yet" error
    referencing the funded-run gate. Containerised judge stays
    deferred per the brief's pre-run checklist.
  - `--smoke` is now 12 offline checks (was 1): `normalizeRow` parsing,
    defensive empty-row handling, end-to-end dispatch through the stub
    answerer (patch produced, instance_id threaded through, real-mode
    rejected cleanly).
- **`agentkitCodemodeExecutor` shim — Direction 1 pre-submission
  gate cleared (2026-06-13).** New
  `@agentkit-js/aisdk` export `agentkitCodemodeExecutor(opts)`
  conforms to the Cloudflare codemode `Executor` interface
  (`execute(code, providersOrFns) => Promise<{result, error?, logs?}>`)
  and runs the LLM-emitted code inside any agentkit `WasmKernel`
  (QuickJSKernel / PyodideKernel / WasmtimeKernel / RemoteSandboxKernel).
  The contract types are reproduced structurally — no
  `@cloudflare/codemode` import — so consumers keep their bundle
  clean. Supports both the flat `Record<string, fn>` and the
  namespaced `ResolvedProvider[]` shapes, plus `positionalArgs`.
  Implemented as a marker-and-rerun loop parallel to
  `ProgrammaticOrchestrator` but reshaped for codemode's
  `await tools.namespace.method(args)` authoring style. Uses a
  Proxy-based `tools` global so unknown leaves throw a clear
  message rather than silent `undefined`. Console output is
  surfaced via each kernel's existing `KernelResult.logs`
  accumulation, sidestepping per-run console-shim resets in some
  kernels. 6 new unit tests (14 total in `aisdk`); `bun run
  typecheck` passes 50/50. Unblocks the `cloudflare/agents`
  recipe-page PR draft at
  `docs/strategy/upstream-prs/cloudflare-codemode-byo-executor.md`.
- **`@agentkit-js/mcp-server` stdio entry point — response to
  `awesome-mcp-servers#7910`'s Glama listing requirement.** New
  `packages/mcp-server/src/stdio.ts` wires the existing
  transport-agnostic `McpAgentServer.handle()` to a
  spec-conformant MCP stdio transport (newline-delimited JSON
  per the 2025-11-25 spec § stdio: stdout for responses, stderr
  for logs, no embedded newlines, notifications get no reply).
  `package.json` adds the `agentkit-mcp-server` bin and a
  `./stdio` subpath export. New `packages/mcp-server/Dockerfile.glama`
  ships the Glama health-check image. 6 new unit tests
  (`stdio.test.ts`) cover the framing rules. README rewritten to
  document the three transports (stdio / HTTP / direct `handle()`).
  Action queue for follow-up steps (Glama submission, PR
  amendment) lives at
  `docs/strategy/upstream-prs/action-queue-2026-06-12.md`.
- **Upstream-PR maintainer-response log — first responses in.**
  `docs/strategy/upstream-prs/README.md` now records the three
  responses received on 2026-06-12: `awesome-mcp-servers#7910`
  is conditionally accepted (Glama listing + badge), Mastra
  `#17884` is **closed** by `@roaminro` with "we're not adding
  any new third-party projects to that section at the moment"
  (logged as a falsifiability data point — re-pitch is gated on
  a public benchmark number per Direction 2, draft is *not*
  prepared in advance to avoid premature re-open), and
  `vercel/ai#16063` is open with no response yet (waiting per
  the 30-day-then-bump-once etiquette).
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
