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
| `@wasmagent/core`                      | ★    | The runtime. Every other package depends on it.                                                       |
| `@wasmagent/kernel-quickjs`            | ★    | Cross-platform JS WASM kernel — the entry the Cloudflare codemode "third-party executor" hook expects. |
| `@wasmagent/kernel-pyodide`            | ★    | Edge-safe Python; no competitor kernel ships this. Fills the "Python execution" diff vs Cloudflare.    |
| `@wasmagent/kernel-wasmtime`           | ★    | True WASM (Javy → QuickJS-in-WASM); paired with kernel-quickjs covers the WASM tier.                   |
| `@wasmagent/kernel-remote`             | ★    | Third (microVM) tier — E2B / Cloudflare Sandbox. Required to honor "three-tier" claim.                 |
| `@wasmagent/mcp-server`                | ★    | The two-tool code-mode MCP shape. Direct competitor to Cloudflare Code Mode MCP.                      |
| `@wasmagent/evals-runner`              | ★    | Public-leaderboard play (Direction 2). Statistics axis is the differentiator vs Mastra.               |
| `@wasmagent/cli`                       | ★    | Single binary surface for `agentkit run / devtools / evals / model`. Discovery entry for newcomers.   |
| `@wasmagent/aisdk`                     | ◆    | Vercel AI SDK adapter. Primary contributor pipeline; in flight upstream (issue #16063).               |
| `@wasmagent/mastra-sandbox`            | ◆    | Mastra sandbox provider; in flight upstream (issue #17884).                                           |
| `@wasmagent/claude-agent-sdk`          | ◆    | Anthropic Claude Agent SDK adapter. Tracks v0/v1 SDK type evolution.                                  |
| `@wasmagent/openai-agents`             | ◆    | OpenAI Agents JS adapter. Tracks `@openai/agents` `Tool<T>` shape.                                      |
| `@wasmagent/devtools`                  | ◆    | Cross-framework local Studio (D5 GenAI semconv ingest). Direction 5 promotes this further.            |
| `@wasmagent/otel-exporter`             | ◆    | OTLP/HTTP exporter. Companion to devtools' framework-agnostic story.                                  |
| `@wasmagent/agent-prompts`             | ◆    | Reusable system prompts. Small surface, but feeds adapter packages.                                   |
| `@wasmagent/react`                     | ◆    | `useAgentRun()` for Next.js. Pairs with the AI SDK adapter in chat-UI scenarios.                      |
| `@wasmagent/cloudflare-worker`         | ◆    | Reference Worker entry — proves edge story. Pairs with kernel-quickjs.                                |
| `@wasmagent/model-anthropic`           | ◆    | Anthropic adapter — needed for prompt-cache discipline (a core differentiator).                       |
| `@wasmagent/model-openai`              | ◆    | OpenAI adapter — also the parent class of `GenericOpenAICompatModel` recipes.                         |
| `@wasmagent/model-local`               | ◆    | Embedded local LLM (node-llama-cpp + grammar). Unique vs every competitor; offline-only stories.      |
| `@wasmagent/tools-browser`             | ◆    | Browser automation. Pairs with bscode's verifier and is a natural code-mode tool surface.             |
| `@wasmagent/tools-rag`                 | ◆    | Embedding + vector store tools. Common scenario; small surface.                                       |
| `@wasmagent/tools-web`                 | ◆    | Web search adapters (Tavily / Brave / Perplexity). Common scenario; small surface.                    |
| `@wasmagent/model-deepseek`            | ▽    | OpenAI-compatible endpoint — covered by `GenericOpenAICompatModel` + recipe.                          |
| `@wasmagent/model-doubao`              | ▽    | OpenAI-compatible endpoint — covered by `GenericOpenAICompatModel` + recipe.                          |
| `@wasmagent/model-minimax`             | ▽    | OpenAI-compatible endpoint — covered by `GenericOpenAICompatModel` + recipe.                          |
| `@wasmagent/model-moonshot`            | ▽    | OpenAI-compatible endpoint (Kimi) — covered by `GenericOpenAICompatModel` + recipe.                   |
| `@wasmagent/model-qwen`                | ▽    | OpenAI-compatible endpoint (DashScope) — covered by `GenericOpenAICompatModel` + recipe.              |
| `@wasmagent/model-zhipu`               | ▽    | OpenAI-compatible endpoint (GLM) — covered by `GenericOpenAICompatModel` + recipe.                    |
| `@wasmagent/a2a`                       | ▽    | A2A (Agent2Agent) adapter. Cross-framework protocol; low organic demand so far. Re-tier on signal.    |
| `@wasmagent/ag-ui`                     | ▽    | AG-UI protocol adapter. Same shape as a2a — re-tier when the upstream protocol stabilizes.            |
| `@wasmagent/ui-cards`                  | ▽    | Card-block parser. Useful, but not on the embedded-runtime path.                                      |
| `@wasmagent/ui-cards-react`            | ▽    | React renderer for ui-cards. Will move with `ui-cards` — re-tier if either gets external traction.    |

**Tier counts (2026-06-12):** 8 ★ · 15 ◆ · 10 ▽.

## What "maintenance-mode" means in practice

Each ▽ package carries a top-of-`README.md` banner with this exact
shape (added in the same PR that publishes this file):

```md
> **Maintenance-mode** (▽). This package is functional and security-patched, but is **not** receiving proactive feature work — it is dominated by `GenericOpenAICompatModel` + a recipe in [`docs/guides/openai-compat-recipes.md`](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/openai-compat-recipes.md). See [maintenance tiers](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/strategy/maintenance-tiers.md) for the rationale. If you actively use this package and want it promoted to ◆ Narrative, open an issue tagged `tier:promote-request` with your use case.
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
  for two minor versions and download data shows fewer than 100/week
  sustained for two consecutive quarters. Demotion lands with the
  same banner above.
- **★ → other:** unanimous maintainer agreement and a strategy
  memo entry. ★ exists to mark "the embedded-runtime thesis";
  demoting one is a strategy change, not a maintenance change.

## Relation to the 1.0 freeze

The 2026-12-15 1.0 freeze (per
[`api-stability.md`](api-stability.md#10-freeze-schedule)) applies
*only* to `@wasmagent/core`. Every other package follows
independent SemVer. ◆ packages that track an upstream still in
flux stay 0.x past 1.0; ▽ packages stay 0.x indefinitely until
demand signals warrant promotion.

## bscode funnel-cost reduction (2026-06-13)

The brief's Direction 4 also calls out bscode itself: "considere把 Web
IDE 部分降为可选 (使漏斗维护成本与其转化价值匹配)." First-round
progress 2026-06-13 (bscode commit linked from agentkit-js
[`CHANGELOG.md`](../../CHANGELOG.md)):

- The new `/recipes` reverse-funnel route is **architecturally
  separate** from the IDE — it imports only `useState` from React;
  every IDE component (Editor / Terminal / FileTree / FileBrowser
  / WebTerminal / WebContainer hooks / JSZip) is excluded from the
  `/recipes` chunk.
- The 535-line `FrameworkApiMap` modal on the IDE home (`/`) is now
  `next/dynamic` lazy-loaded with `{ssr: false}` and only mounts on
  open. Removes the modal markup from the `/` first-paint chunk.
- `JobsPanel` (577 LOC) lives on its own `/jobs` route already, so
  it's a separate chunk by virtue of Next's app-dir routing.

Funnel-cost takeaway: a visitor arriving via
`?source=bscode-<framework>-recipe` UTM (the reverse-funnel
audience) downloads roughly the `/recipes/page.tsx` chunk (~6 KB
of React + the inline recipe data) — orders of magnitude smaller
than the IDE shell. The IDE itself remains useful as a CodeAgent
demo for visitors who arrive at `/`; the brief's "降为可选" is now
delivered by routing, not by ripping the IDE out.

Further reductions tracked under `governance:bscode-shrink` issues
(target: total LOC ≤ agentkit-js framework LOC by 2026-Q4).

## Falsifiability

If after two quarters no ▽ package has either (a) been promoted
or (b) showed sustained > 100 downloads/week, the right answer is
to move to "deprecated → archive in 2027-Q1" on those packages
rather than carry them forward. The signal is npm download data
+ issue activity; the decision lands as a separate PR with the
data attached.
