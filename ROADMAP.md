# agentkit-js — Roadmap

> Last refreshed: 2026-06-12. Refresh quarterly; keep stamped with the
> last review date so consumers can spot rot.

This roadmap is the public version of the strategic plan that drives the
repo. It is opinionated about what we are NOT going to chase. The
discussion of why each item exists, and what it competes with, lives in
[the strategy memo](docs/strategy/2026-06-competitiveness.md) (added in
the same A6 commit; see also the embedded "Why" lines below).

## Strategic axes (4 lines we steer by)

- **S1 — Stop competing as a framework. Get embedded as a runtime.**
  The TS-agent-framework race has a winner with 4 orders of magnitude
  more distribution; chasing it is a losing play. Code-mode (Cloudflare
  Code Mode MCP, Red Hat codemode-lite, Anthropic's "code execution with
  MCP") is converging on "tools-as-code" — and there is no neutral,
  multi-language, multi-isolation-tier code-mode runtime on the market.
  agentkit's three-tier kernel matrix (in-process / WASM / remote)
  already exists. We sell it as a component to the framework leaders.

- **S2 — Replace self-built numbers with public-leaderboard numbers.**
  Mastra's "94.87% on LongMemEval" is the kind of citation we cannot
  match with a 50-turn synthetic trace. We publish on public benchmarks
  (LongMemEval first; SWE-bench-lite-class second) and report cost-axis
  data the competitors don't.

- **S3 — DevX: a zero-deploy local Studio, not a SaaS.**
  Mastra Studio's metrics tab (cost / token / latency / errors) earns
  its rep. agentkit already emits all the data; we add the aggregator
  + a vanilla HTML page served by `agentkit devtools` (A4 — shipped).
  No hosting, no account, no telemetry phone-home.

- **S4 — bscode is a funnel, not a product.**
  bscode (the CF Workers + Next.js demo) drives traffic to
  `npm add @agentkit-js/core`. It only demos already-published
  framework APIs; new generic logic lands in agentkit-js first.

## Shipped (2026-06)

- **A1 — Code-mode MCP server** (`@agentkit-js/mcp-server` ≥ 0.3).
  Two-tool MCP surface (`docs_search` + `execute_code`) collapses N
  downstream tools behind one in-sandbox dispatch. Pairs with any
  agentkit kernel for unified security policy. Token-savings benchmark
  in CI: code-mode is ≤14% of direct-MCP at N=30 tools, monotonic in N.
  Doc: [`docs/guides/code-mode.md`](docs/guides/code-mode.md).

- **A1.1 — Unified security policy face.** `CapabilityManifest` now
  carries `env / cpuMs / memoryLimitBytes` alongside the existing
  allowedHosts / allowedReadPaths / allowedWritePaths / extraCapabilities.
  Cross-kernel honouring matrix documented in
  [`packages/core/src/executor/types.ts`](packages/core/src/executor/types.ts).

- **A2 — Vercel AI SDK + Mastra plugin packages.**
  - [`@agentkit-js/aisdk`](packages/aisdk) — `sandboxedJsTool()` and
    `codeModeTool()` factories. AI SDK majors 4–6 supported via
    structural typing.
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
  "considering" to "in flight" 2026-06-12 with the skeleton harness
  at [`examples/benchmarks/swe-bench-lite.mjs`](examples/benchmarks/swe-bench-lite.mjs)
  and the placeholder report at
  [`docs/reports/swe-bench-lite-pending.md`](docs/reports/swe-bench-lite-pending.md).
  Direction 2 of the 2026-06-12 optimization brief; comparator
  Cloudflare Code Mode MCP has not published a SWE-bench number,
  so the first credible run owns the citation slot. Pre-run
  checklist (containerised judge, cache-token plumbing, dry-run
  gate) lives in the harness file's docblock.

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
