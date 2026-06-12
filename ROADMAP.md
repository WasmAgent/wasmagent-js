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

## In flight (2026-Q3)

- **A3 — LongMemEval public benchmark.** Sample-mode harness shipped
  ([`examples/benchmarks/longmemeval.mjs`](examples/benchmarks/longmemeval.mjs)).
  Full-mode runs against any OpenAI-compatible endpoint (local Ollama
  by default). Public number lives in `docs/benchmarks.md` and is
  refreshed quarterly with each kernel + observation prompt change.

- **A6 — Maintainership signals.** ROADMAP (this file), CONTRIBUTING
  (added 2026-06-12), kernel sandbox-escape SLA in SECURITY.md.

## Considering (post-Q3, no commitment)

- **B2 — Cloudflare 2026 platform primitives.** Browser Run backend
  for `tools-browser`, CF Agent Memory as a `KvBackend`, Workflows
  example for long-running checkpoints. Tracks the 2026 Agents Week
  (May) feature set.

- **Public SWE-bench-lite-class run** for the code-mode dispatch
  pattern. Comparator: Cloudflare Code Mode MCP server (closed-source
  numbers).

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
