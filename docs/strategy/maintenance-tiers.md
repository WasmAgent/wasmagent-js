# Maintenance Tiers — 33-Package Classification

> Last refreshed: **2026-06-12**.
> Direction 4 of the 2026-06 optimization brief. The strategy memo
> ([`2026-06-competitiveness.md`](2026-06-competitiveness.md)) made
> the case in prose; this file makes it actionable.

## Why this file exists

Single maintainer + 33 packages + an 80-kLOC flagship demo
(`bscode`) is a load-bearing problem disguised as an inventory
problem. Every package implies a release cadence, an issue queue,
a CHANGELOG row, and a slot on the 1.0-freeze checklist
([`api-stability.md`](api-stability.md#10-freeze-schedule)).

This page assigns every package to one of three tiers so adopters,
co-maintainer candidates, and the bot that drafts the bi-weekly
release note all read the same prioritization.

## Tier definitions

- **Core (★).** The "embedded runtime" thesis lives here.
  Continuous investment, full SemVer protection at 1.0
  (where applicable), graduated experimental surfaces by 2026-12-15.
  An issue tagged `core` is on the maintainer's first daily pass.
- **Narrative (◆).** Carries the story to the leaders we want to
  be embedded in. Tracks upstream contracts; experimental status
  is acceptable as long as the upstream is moving. Best contributor
  pipeline for the co-maintainer ask.
- **Maintenance-mode (▽).** Useful, working, but **not** receiving
  proactive feature work. Bug fixes only; security patches
  honored. Documented dominance by `GenericOpenAICompatModel` +
  recipe (for model presets) or by a core primitive (for the
  others). Candidates for archival in a future 1.x cycle once
  download data confirms low usage.

A package's tier is set by what carries the embedded-runtime
thesis, not by code size or test count.

## Classification table

| Package                                  | Tier | Rationale (one line)                                                                                  |
|------------------------------------------|------|--------------------------------------------------------------------------------------------------------|
| `@agentkit-js/core`                      | ★    | The runtime. Every other package depends on it.                                                       |
| `@agentkit-js/kernel-quickjs`            | ★    | Cross-platform JS WASM kernel — the entry the Cloudflare codemode "third-party executor" hook expects. |
| `@agentkit-js/kernel-pyodide`            | ★    | Edge-safe Python; no competitor kernel ships this. Fills the "Python execution" diff vs Cloudflare.    |
| `@agentkit-js/kernel-wasmtime`           | ★    | True WASM (Javy → QuickJS-in-WASM); paired with kernel-quickjs covers the WASM tier.                   |
| `@agentkit-js/kernel-remote`             | ★    | Third (microVM) tier — E2B / Cloudflare Sandbox. Required to honor "three-tier" claim.                 |
| `@agentkit-js/mcp-server`                | ★    | The two-tool code-mode MCP shape. Direct competitor to Cloudflare Code Mode MCP.                      |
| `@agentkit-js/evals-runner`              | ★    | Public-leaderboard play (Direction 2). Statistics axis is the differentiator vs Mastra.               |
| `@agentkit-js/cli`                       | ★    | Single binary surface for `agentkit run / devtools / evals / model`. Discovery entry for newcomers.   |
| `@agentkit-js/aisdk`                     | ◆    | Vercel AI SDK adapter. Primary contributor pipeline; in flight upstream (issue #16063).               |
| `@agentkit-js/mastra-sandbox`            | ◆    | Mastra sandbox provider; in flight upstream (issue #17884).                                           |
| `@agentkit-js/claude-agent-sdk`          | ◆    | Anthropic Claude Agent SDK adapter. Tracks v0/v1 SDK type evolution.                                  |
| `@agentkit-js/openai-agents`             | ◆    | OpenAI Agents JS adapter. Tracks `@openai/agents` Tool<T> shape.                                      |
| `@agentkit-js/devtools`                  | ◆    | Cross-framework local Studio (D5 GenAI semconv ingest). Direction 5 promotes this further.            |
| `@agentkit-js/otel-exporter`             | ◆    | OTLP/HTTP exporter. Companion to devtools' framework-agnostic story.                                  |
| `@agentkit-js/agent-prompts`             | ◆    | Reusable system prompts. Small surface, but feeds adapter packages.                                   |
| `@agentkit-js/react`                     | ◆    | `useAgentRun()` for Next.js. Pairs with the AI SDK adapter in chat-UI scenarios.                      |
| `@agentkit-js/cloudflare-worker`         | ◆    | Reference Worker entry — proves edge story. Pairs with kernel-quickjs.                                |
| `@agentkit-js/model-anthropic`           | ◆    | Anthropic adapter — needed for prompt-cache discipline (a core differentiator).                       |
| `@agentkit-js/model-openai`              | ◆    | OpenAI adapter — also the parent class of `GenericOpenAICompatModel` recipes.                         |
| `@agentkit-js/model-local`               | ◆    | Embedded local LLM (node-llama-cpp + grammar). Unique vs every competitor; offline-only stories.      |
| `@agentkit-js/tools-browser`             | ◆    | Browser automation. Pairs with bscode's verifier and is a natural code-mode tool surface.             |
| `@agentkit-js/tools-rag`                 | ◆    | Embedding + vector store tools. Common scenario; small surface.                                       |
| `@agentkit-js/tools-web`                 | ◆    | Web search adapters (Tavily / Brave / Perplexity). Common scenario; small surface.                    |
| `@agentkit-js/model-deepseek`            | ▽    | OpenAI-compatible endpoint — covered by `GenericOpenAICompatModel` + recipe.                          |
| `@agentkit-js/model-doubao`              | ▽    | OpenAI-compatible endpoint — covered by `GenericOpenAICompatModel` + recipe.                          |
| `@agentkit-js/model-minimax`             | ▽    | OpenAI-compatible endpoint — covered by `GenericOpenAICompatModel` + recipe.                          |
| `@agentkit-js/model-moonshot`            | ▽    | OpenAI-compatible endpoint (Kimi) — covered by `GenericOpenAICompatModel` + recipe.                   |
| `@agentkit-js/model-qwen`                | ▽    | OpenAI-compatible endpoint (DashScope) — covered by `GenericOpenAICompatModel` + recipe.              |
| `@agentkit-js/model-zhipu`               | ▽    | OpenAI-compatible endpoint (GLM) — covered by `GenericOpenAICompatModel` + recipe.                    |
| `@agentkit-js/a2a`                       | ▽    | A2A (Agent2Agent) adapter. Cross-framework protocol; low organic demand so far. Re-tier on signal.    |
| `@agentkit-js/ag-ui`                     | ▽    | AG-UI protocol adapter. Same shape as a2a — re-tier when the upstream protocol stabilizes.            |
| `@agentkit-js/ui-cards`                  | ▽    | Card-block parser. Useful, but not on the embedded-runtime path.                                      |
| `@agentkit-js/ui-cards-react`            | ▽    | React renderer for ui-cards. Will move with `ui-cards` — re-tier if either gets external traction.    |

**Tier counts (2026-06-12):** 8 ★ · 15 ◆ · 10 ▽.

## What "maintenance-mode" means in practice

Each ▽ package carries a top-of-`README.md` banner with this exact
shape (added in the same PR that publishes this file):

```md
> **Maintenance-mode** (▽). This package is functional and security-patched, but is **not** receiving proactive feature work — it is dominated by `GenericOpenAICompatModel` + a recipe in [`docs/guides/openai-compat-recipes.md`](https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/openai-compat-recipes.md). See [maintenance tiers](https://github.com/telleroutlook/agentkit-js/blob/main/docs/strategy/maintenance-tiers.md) for the rationale. If you actively use this package and want it promoted to ◆ Narrative, open an issue tagged `tier:promote-request` with your use case.
```

For non-model ▽ packages (`a2a`, `ag-ui`, `ui-cards`,
`ui-cards-react`), the banner replaces the
"GenericOpenAICompatModel + recipe" sentence with the relevant
"dominated by ..." reason from the table above.

The banner is the only behavior change — no `package.json`
deprecation flag, no npm dist-tag move, no signal that would
appear as a yank. Users who depend on these packages today should
not see breakage; they should see honest signal about the
maintenance posture.

## How a package moves between tiers

- **▽ → ◆:** open an issue tagged `tier:promote-request`. The
  case is: an upstream we want to be embedded in (per
  [`ROADMAP.md`](../../ROADMAP.md) S1) actively recommends this
  package, OR organic npm downloads cross 1k/week sustained.
- **◆ → ▽:** if a ◆ package's upstream contract has been stable
  for two minor versions and download data shows < 100/week
  sustained for two consecutive quarters. Demotion lands with the
  same banner above.
- **★ → other:** unanimous maintainer agreement and a strategy
  memo entry. ★ exists to mark "the embedded-runtime thesis";
  demoting one is a strategy change, not a maintenance change.

## Relation to the 1.0 freeze

The 2026-12-15 1.0 freeze (per
[`api-stability.md`](api-stability.md#10-freeze-schedule)) applies
*only* to `@agentkit-js/core`. Every other package follows
independent SemVer. ◆ packages that track an upstream still in
flux stay 0.x past 1.0; ▽ packages stay 0.x indefinitely until
demand signals warrant promotion.

## Falsifiability

If after two quarters no ▽ package has either (a) been promoted
or (b) showed sustained > 100 downloads/week, the right answer is
to move to "deprecated → archive in 2027-Q1" on those packages
rather than carry them forward. The signal is npm download data
+ issue activity; the decision lands as a separate PR with the
data attached.
