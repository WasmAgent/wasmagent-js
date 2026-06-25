# Changelog

All notable changes to **wasmagent** are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/).

> **Cadence:** we aim for a release every two weeks; significant fixes
> may ship sooner. Tagged versions on GitHub and npm correspond
> 1-to-1 with sections in this file.
>
> **Stability tiers:** each release section is split into three subsections.
> `### Stable changes` — exports covered by SemVer guarantees (tier-0 and tier-1
> packages; see `docs/api/stability-policy.md`). `### Beta changes` — tier-2
> packages; minor extensions allowed, no silent breaking. `### Experimental changes`
> — tier-3 packages; may change in a minor release.
>
> **Frozen API surface:** see
> [`docs/api/stability-policy.md`](docs/api/stability-policy.md)
> for which exports are covered by SemVer guarantees. Anything in
> tier-3 / `@experimental` may change in a minor release.

## [0.3.0] — 2026-06-18

Major feature release. Closes the two highest-priority differentiation axes
and completes the go-to-market hardening pass.

### Added
- **Axis 8 — `GoalDirectedAgent`** (`@wasmagent/core`). Agent synthesises its
  own success criteria (scout → criteria → execute → verify → done), verifies
  deterministically or via adversarial-defaulted `LLMJudge`, retries with
  hints. End-to-end baseline run: 10.6 KB OAuth doc, 7 self-synthesised
  criteria, iter 1 verified. CLI: `wasmagent goal "<task>"`.
- **Axis 9 — Adaptive execution** (`@wasmagent/core`). Three recovery layers:
  L1 `Tool.alternatives` + `tool_fallback_offered` event; L2 `enableToolSynthesis`
  + `tool_synthesised` event; L3 `allowNegotiate` + `onAdaptationProposed`.
  All three layers wire through `ToolCallingAgent`, `CodeAgent`, `GoalDirectedAgent`
  automatically. Paired-stat verified: McNemar p=1.86e-9 (n=30, b=30, c=0).
  CLI: `wasmagent goal --allow-negotiate`.
- **`npx @wasmagent/cli init <name>`** — scaffolds a new agent project directory
  (package.json + agent.mjs + .env.example) without a prior install step.
- **`examples/cf-production/index.mjs`** — single-file Cloudflare Worker with
  JWT auth, KV rate limiting, and SSE streaming; ready for `wrangler deploy`.
- **`examples/owasp-demo/owasp-demo.mjs`** — standalone OWASP Agentic Top 10
  interception demo (4 scenarios, no LLM/API key required, exit 0/1 CI-friendly).
- **`docs/reports/TEMPLATE.md`** — universal paired-statistics report template.
- **`wasmagent-cli` bin alias** in `@wasmagent/cli` for `npx @wasmagent/cli`.
- Root `package.json` keywords for npm discoverability (`portable-executor`,
  `agent-sandbox`, `code-mode`, `wasm-kernel`, etc.).

### Changed
- README first screen: replaced bloated strategy-memo callout block with a
  15-line copy-paste ready TypeScript snippet and clean doc links.
- bscode README: removed all internal axis codes (B1–C4, S1', G1, B-D2) from
  the visible body; docs table and feature table now use plain English labels.

## [Unreleased]

### Added (2026-06-25 — Phase 0 + Phase 1 product)

- **`wasmagent guard`** — MCP tool policy enforcement CLI. Reads `wasmagent.policy.yaml`,
  vets each tool via `@wasmagent/mcp-gateway`, prints allow/deny table with reason codes,
  exits 1 on any denial.
- **`wasmagent scan-mcp <tools.json>`** — Static risk scan: injection / exfiltration / sampling
  abuse / invisible chars / rug-pull. Prints per-tool findings with severity and category.
- **`wasmagent evidence export --input <aep.jsonl> [--format json|html] [--out <file>]`** —
  Exports AEP evidence bundle as a JSON summary or self-contained HTML report.
- **`wasmagent init --guard`** — Generates a starter `wasmagent.policy.yaml` in the current
  directory with allow/deny/approval/budget/redaction sections.
- **`examples/dangerous-tool-demo/`** — Runnable demo: 5 mock MCP tools scanned by MCPGateway
  (1 denied, 1 ask_user, 1 taint-tracked), AEP evidence bundle emitted. No API key required.
- **`docs/guides/mcp-guard.md`** — 5-minute quickstart, policy YAML reference, programmatic
  usage, threat model.
- **`README.md`** — Added "WasmAgent 0.1: Evidence Layer for MCP Agents" positioning above
  the package list.

### Added (2026-06-25 — gap fill)

- **`@wasmagent/aep`** — `mcp_server_card_digest` (nullish) + `signature {alg,key_id,sig}` added to `AEPRecord`; `human_approval_budget` added to `BudgetLedger`. 4 tests pass.
- **`@wasmagent/otel-exporter`** — `AEP_SPAN_NAMES` 补全 `agent.run` / `llm.generate` / `tool.call`；新增 `agentRunSpanAttrs` / `llmGenerateSpanAttrs` / `toolCallSpanAttrs`。49 tests pass。
- **`@wasmagent/mcp-policy` v0.1.0** — `PolicyBundle` 命名版本化规则集合，`default()` / `strict()` / `extend()`，SHA-256 digest。3 tests pass。
- **`@wasmagent/mcp-attestation` v0.1.0** — `CapabilityAttestation`、`AttestationRegistry`、`buildAttestation()`，四级 attestation level（self/community/operator/audited）。2 tests pass。
- **`packages/wit/wasmagent.wit`** — WASM Component Plugin ABI (P1-1)：`policy` / `verifier` / `redactor` / `evidence` WIT 接口，`wasmagent-runtime` world。
- **`docs/strategy/research-public-edition.md`** — Research Edition / Public Edition 分层边界文档。

### Added (2026-06-25 — P2)

- **`docs/packages.md`** — `@wasmagent/mcp-gateway` 加入 Security & Governance 表格和 tier 表。

### Added (2026-06-25 — P1-5 Budget Ledger)

- **`@wasmagent/aep` — `BudgetLedger`** (`packages/aep/src/types.ts`). Per-run budget
  consumption tracking: `token_budget`, `latency_budget`, `tool_budget`, `risk_budget`,
  `retry_budget`. Optional `budget_ledger` field added to `AEPRecord`. `AEPEmitter.setBudgetLedger()`
  for fluent assembly. 4 tests pass.

### Added (2026-06-25 — Day 61-90)

- **`@wasmagent/mcp-gateway` v0.1.0** (`packages/mcp-gateway/`) — Alpha standalone gateway package.
  Re-exports all of `@wasmagent/mcp-firewall`; adds `GatewayMiddleware` + `composeMiddleware()` for
  composable request/response middleware chains; `InMemoryAuditLogger` + `buildAuditEvent()` for
  per-invocation audit trails with `denied()` / `stateChanging()` filters. 5 tests pass.

### Added (2026-06-25 — Day 31-60)

- **AgentDojo-style prompt injection smoke tests** (`packages/mcp-firewall/src/prompt-injection-smoke.test.ts`).
  8 regression baseline tests covering: direct injection in tool descriptor (vetTool/evaluatePolicy/MCPGateway all
  block), indirect injection via tool result (taintObservation detects `instructionLikeTextDetected=true`),
  exfiltration attempt detection. These serve as the WasmAgent anti-injection regression suite.

### Added (2026-06-25 — AEP P0 reform)

- **`@wasmagent/aep` v0.1.0** (`packages/aep/`) — Agent Evidence Protocol.
  `AEPRecord` / `ActionEvidence` / `CapabilityDecision` / `InputRef` / `OutputRef` /
  `VerifierResult` types (Zod-validated). `AEPEmitter` collects runtime decisions and
  builds signed-ready evidence bundles. `AEPEmitter.digestContent()` for SHA-256 artifact
  hashing. This is the cross-repo public data contract consumed by trace-pipeline for
  training export and audit. Schema version: `aep/v0.1`.

- **`@wasmagent/mcp-firewall` v1.1.0 — Gateway layer** (`packages/mcp-firewall/src/gateway.ts`).
  Extends the existing firewall with: `RequestIdentity` + `createRequestIdentity()` (principal
  hash + session propagation for multi-agent chains); `ServerCard` + `buildServerCard()` (tool
  manifest digest + operator-verified flag); `isStateChangingTool()` (regex heuristic for
  mutation-risk classification); `MCPGateway` class that wraps vetting + policy + consent and
  emits `GatewayDecision` with `evidenceRef` fields wired to AEP.

- **`@wasmagent/otel-exporter` — AEP span names** (`packages/otel-exporter/src/aep-span-names.ts`).
  `AEP_SPAN_NAMES` constants: `mcp.request`, `policy.check`, `sandbox.exec`, `verifier.check`,
  `redaction.apply`, `dataset.export`. Four span-attribute helpers:
  `mcpRequestSpanAttrs`, `policyCheckSpanAttrs`, `sandboxExecSpanAttrs`, `verifierCheckSpanAttrs`.
  All exported from package root.

### Alpha / new packages

- **`@wasmagent/mcp-firewall` v1.1.0** — Runtime firewall for MCP and tool-augmented agents.
  Deterministic, no ML. Four layers:
  - `vetTool()` — static scan of description/inputSchema for injection, exfiltration, invisible chars, sampling abuse.
  - `evaluatePolicy()` — per-call allow / deny / ask_user / dry_run with pluggable `PolicyRule[]`.
  - `taintObservation()` + `renderTaintedObservation()` — wrap tool outputs in untrusted XML boundary before prompt assembly.
  - `InMemoryConsentLedger` — record/query/revoke user approvals scoped to tool snapshot hashes (rug-pull safe).
  Published to npm as `@wasmagent/mcp-firewall@1.1.0` and to the official MCP Registry as `io.github.telleroutlook/mcp-server`.

- **`@wasmagent/capability-compiler` v0.1.0** — Compile `CapabilityManifest` to three targets:
  - `compileToMcpSchema()` → JSON Schema fragment + Markdown doc table + capability tags.
  - `compileToPolicy()` → executable allow/deny/warn rules per tool call.
  - `compileToTraceValidator()` → ADP trace checker that flags manifest violations.
  Published to npm as `@wasmagent/capability-compiler@0.1.0`.

### Stable changes

- **`@wasmagent/mcp-server` v1.1.1** — Added `ToolDescriptorSnapshot`, `detectRugPull()`,
  `snapshotTool()`, `hashContent()` exports (P0 MCP firewall foundation). Added `mcpName`
  field and `server.json` for MCP Registry publication.

- **`@wasmagent/compliance`** — New `EvidenceAdmissionContract` + `EvidenceRow` types
  (`src/ir/EvidenceAdmission.ts`) with Zod schemas. Defines the four evidence row tiers
  (admitted / smoke / diagnostic / fixture) that gate claim-eligible benchmark numbers.

- **`@wasmagent/evals-runner`** — New `admitRows()` + `gateReport()` functions
  (`src/evidenceGate.ts`). Runs `AdmissionRule[]` against a batch of `EvidenceRow` objects
  and renders a Markdown report with watermark when admission rate is low.

- **IFEval N=10 seed sweeps** — Qwen2.5-1.5B (seeds 42-52, N=11): full_pcl 53.8% ± 2.3 pp,
  +12.5 pp over direct with 0 losses across 550 pairs. Llama-3.2-1B (seeds 42-51, N=10):
  full_pcl 58.2% ± 2.7 pp, ties prompt_retry (within noise), strict win over direct.

### RLAIF infrastructure — batch rollout sampling + ranking (2026-06-22).
  Full pipeline for generating RLAIF training data from `@wasmagent/core`:

  - **`RemoteSandboxKernel.runCommand(cmd)`** (`@wasmagent/kernel-remote`) —
    executes real shell commands (e.g. `npm install`, `vite build`) inside an
    E2B microVM and returns `{ stdout, stderr, exitCode }`. Distinct from
    `run()` (code-snippet execution); lets bscode use E2B as a real CI
    sandbox. Exported via `CommandResult` type.

  - **`BuildPassesVerifier` / `VisualAssertVerifier`** — new `Verifier`
    implementations for `VerificationPipeline`. `build_passes` maps to
    `exitCode === 0`; `visual_assert` maps to `BuildResultSnapshot.visual.verdict`.
    Both accept an injected callback so `@wasmagent/core` stays decoupled from
    bscode's KV channel. State `running` / `unknown` always fails — never
    defaults to pass.

  - **`ToolOutputSummarizer`** (`summarizeToolOutput(raw, opts?)`) — deterministic
    head+tail truncation for tool outputs. Training data and LLM inference use
    the same compressed form. Zero LLM calls. Configurable `maxBytes` / `keepFirstLines`
    / `keepLastLines`.

  - **`RolloutForkRunner`** — forks a complete `ToolCallingAgent` run across N
    independent branches, yields `RolloutBranchResult` as each branch completes.
    Unlike `ParallelForkJoinRunner` (which forks a single `model.generate` call),
    this runs the full tool-call loop per branch and persists the complete
    `AgentEvent[]` trajectory. Per-branch temperature, concurrency cap, optional
    `modelFactory` for stateful test mocks. `tool_result` outputs are summarized
    via `summarizeToolOutput` before JSONL persistence.

  - **`KernelPool`** — bounded concurrency pool for `WasmKernel` instances.
    Acquire by rollout ID, release on completion, `[Symbol.asyncDispose]` cleanup.
    Uses a factory function (`() => Promise<WasmKernel>`) rather than a
    `KernelEngine` string so any kernel tier works.

  - **`ScalarLLMJudgeVerifier`** — extends the `LLMJudgeVerifier` reward-hacking
    defences (default-fail, k-of-N, temperature=0.1, strict JSON, independent
    judge model) with two new output modes: **score** (0–10 mean across samples)
    and **pairwise** (`"a" | "b" | "tie"` majority vote). Unparseable responses
    are neutral (`tie` or excluded from mean), never throw. `maxJudgeCallsPerBatch`
    cap skips expensive calls and returns a neutral score of 5.

  - **`RolloutRanker`** — ranks N rollout branches. Pipeline: group by
    `objective_score` (build pass = 1, else = 0) → round-robin pairwise judge
    calls within groups → Bradley-Terry win counts → configurable `RewardFunction[]`
    weighted sum. Reports `powered: boolean` and `minDetectableDeltaPp` via
    Wilson CI; McNemar p-value on top/bottom split. Stats reuse `mcnemarExact`
    and `wilsonCI` from `packages/core/src/ranking/stats.ts`.

  - **`RolloutMemoryStore`** — persists high-quality rollout experiences
    (`objectiveScore === 1` only) to any `Retriever` backend (in-memory, Pinecone,
    Qdrant). `retrieve(task, topK)` returns similar past approaches for system
    prompt injection before the next fork batch. `formatAsSystemPrompt(memories)`
    produces a ready-to-inject block.

  All new types are exported from `@wasmagent/core`'s public barrel.

- **`AgentSupervisor` signal fix** — resolved a pre-existing
  `exactOptionalPropertyTypes` TypeScript error when passing an
  `AbortSignal | undefined` to `agent.run()`. No behaviour change.

- **`CommandResult` type and `runCommand(cmd, opts?)` method** on
  `RemoteSandboxKernel`. Wraps E2B `sandbox.commands.run()` — returns structured
  `{ stdout, stderr, exitCode }` without the code-harness wrapping that `run()`
  applies to JS/Python snippets. Exported from `@wasmagent/kernel-remote`.

- The `CapabilityManifest.env` field is now actually
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

- **`@wasmagent/evals-runner` — `multiTurnMemorySuiteOriginal` exposed
  (2026-06-16).** The 6-item original variant of the multi-turn-memory
  suite is now (a) registered in `REFERENCE_SUITES` under the name
  `"multi-turn-memory-original-6"` and (b) re-exported as a named
  symbol from the package barrel. Background: as the LoCoMo-style
  templates expanded the main `multi-turn-memory` suite to 63 items,
  contract / smoke tests that wanted a fixed denominator had nowhere
  to go — the original 6-item variant was defined but unreachable.
  Now both consumption paths work:
    - `import { REFERENCE_SUITES } from "@wasmagent/evals-runner"`
      and pick `REFERENCE_SUITES["multi-turn-memory-original-6"]`,
    - `import { multiTurnMemorySuiteOriginal } from "@wasmagent/evals-runner"`
      and use directly.
  Caught by `examples/integration-smoke/edge-evals-runner.mjs` as
  part of the 4-axis audit's full-validation pass.

- **`@wasmagent/mcp-server` stdio entry point — response to
  `awesome-mcp-servers#7910`'s Glama listing requirement.** New
  `packages/mcp-server/src/stdio.ts` wires the existing
  transport-agnostic `McpAgentServer.handle()` to a
  spec-conformant MCP stdio transport (newline-delimited JSON
  per the 2025-11-25 spec § stdio: stdout for responses, stderr
  for logs, no embedded newlines, notifications get no reply).
  `package.json` adds the `wasmagent-mcp-server` bin and a
  `./stdio` subpath export. New `packages/mcp-server/Dockerfile.glama`
  ships the Glama health-check image. 6 new unit tests
  (`stdio.test.ts`) cover the framing rules. README rewritten to
  document the three transports (stdio / HTTP / direct `handle()`).
  Action queue for follow-up steps (Glama submission, PR
  amendment) lives at
  `docs/strategy/upstream-prs/action-queue-2026-06-12.md`.

- **`createCodemodeExecutor` shim — Direction 1 pre-submission
  gate cleared (2026-06-13).** New
  `@wasmagent/aisdk` export `createCodemodeExecutor(opts)`
  conforms to the Cloudflare codemode `Executor` interface
  (`execute(code, providersOrFns) => Promise<{result, error?, logs?}>`)
  and runs the LLM-emitted code inside any wasmagent `WasmKernel`
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

- `@wasmagent/claude-agent-sdk` (D1) — wasmagent kernels as Claude
  Agent SDK tools. `sandboxedJsClaudeTool()` and `codeModeClaudeTool()`
  emit the Anthropic-shape `{name, description, input_schema, handler}`
  quadruple, structurally typed so they survive both the v0 and the
  upcoming v1 line of `@anthropic-ai/sdk`. 7 unit tests.

- `@wasmagent/openai-agents` (D1) — wasmagent kernels as OpenAI
  Agents JS tools. `sandboxedJsAgentTool()` and `codeModeAgentTool()`
  emit the `@openai/agents` `Tool<T>` shape (Zod parameters +
  `execute()`). 6 unit tests.

- `docs/guides/integrate-claude-agent-sdk.md` and
  `docs/guides/integrate-openai-agents.md` — install + minimal
  snippets + capability cheat-sheet for each adapter, mirroring the
  existing Vercel AI SDK guide.

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

### Beta changes

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
    `docker run --rm -v $tmp:/work wasmagent-swe-judge:latest`,
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
    stub-answerer path: spins up `JsKernel` + `createCodemodeExecutor`
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
  wasmagent is preserved end-to-end. The bscode home page navbar
  gains a purple "their framework + our kernel →" pill alongside
  the existing green "npm add @wasmagent/core →" pill so the
  reverse-funnel pitch is visible from the very first paint.
  bscode commit
  [`19bc56d`](https://github.com/WasmAgent/bscode/commit/19bc56d).

- **bscode reverse-funnel page — Direction 6 of the 2026-06-12
  optimization brief.** New page in the bscode demo repo,
  `docs/their-framework-our-kernel.md`, documents five recipes
  for dropping wasmagent kernels into the framework the visitor
  already uses (Vercel AI SDK 6 + `sandboxedJsTool`, Cloudflare
  codemode + `createCodemodeExecutor` shim, Mastra +
  `createMastraSandbox`, Anthropic Claude Agent SDK +
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
  codemode users to `@wasmagent/kernel-quickjs` /
  `kernel-pyodide` / `kernel-remote` as a community-maintained
  executor that closes the three explicit gaps in the default
  `DynamicWorkerExecutor` (no Workers binding, Python support,
  `needsApproval` lifecycle). Pre-submission gate: ship the
  `createCodemodeExecutor` shim in `@wasmagent/aisdk` first
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
  reachable via `npx -p @wasmagent/cli wasmagent devtools
  --otel-events-file <path>` so non-wasmagent users do not need
  to install `@wasmagent/core`. The adapter
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
  **2026-12-15 1.0-freeze date** for `@wasmagent/core`, with a
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

- `examples/benchmarks/longmemeval-500.mjs` (D2) — standalone runner
  for the official LongMemEval-500 set with multi-observer
  comparison, per-category breakdown (multi-session row called out
  explicitly as the Mastra weak spot), prompt-cache hit accounting
  (Anthropic `cache_read_input_tokens` summed), and a `--smoke` mode
  that exercises the runner offline so CI doesn't drift. The full
  run is funding-dependent (🖥️ in ROADMAP); a placeholder lives at
  `docs/reports/longmemeval-500-pending.md` with the exact CLI
  command that will populate it.

- `wasmagent devtools --otel-events-file <path>` (D5) — point the
  zero-deploy local Studio at any GenAI semconv source: NDJSON spans
  or OTLP/JSON. The `convertGenAiSpansToEvents()` adapter (9 tests)
  maps `gen_ai.operation.name = invoke_agent | chat | execute_tool`
  spans to the `LoggedEvent` shape the existing aggregator reads, so
  Vercel AI SDK / Mastra / OpenAI Agents JS / Anthropic SDK traces
  render in the same Studio view as wasmagent's own runs.

- `docs/strategy/2026-06-competitiveness.md` — the strategy memo that
  ROADMAP.md has referenced since 2026-06-12 (previously a dangling
  link).

### Experimental changes

<!-- No experimental changes in this batch. -->

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
- Code-mode MCP server (`@wasmagent/mcp-server` ≥ 0.3) with a
  two-tool surface (`docs_search` + `execute_code`) shown to use
  ≤14% of the tokens of direct-MCP at N=30 tools.
- Zero-deploy local Studio: `RunsAggregator` + `EventLogReplay` +
  `agentkit devtools` CLI serving an inline HTML dashboard.
- Statistically rigorous evaluation harness (`@wasmagent/evals-runner`)
  with McNemar exact, Wilson CI, paired bootstrap, six reference
  benchmark suites, and Pareto-front rendering.

[Unreleased]: https://github.com/WasmAgent/wasmagent-js/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/WasmAgent/wasmagent-js/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/WasmAgent/wasmagent-js/releases/tag/v0.2.0
