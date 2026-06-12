# SWE-bench-lite-class code-mode dispatch — multi-answerer report (PENDING)

> **Status: harness skeleton in repo, full run pending funding.** This
> file exists so the path the published report will land at is fixed
> and discoverable. The actual numbers will replace this preamble
> once the run is funded; the harness lives at
> [`examples/benchmarks/swe-bench-lite.mjs`](../../examples/benchmarks/swe-bench-lite.mjs)
> and the methodology lives in this file's "What the published
> report will contain" section.

## Why a placeholder

Direction 2 of the [2026-06-12 optimization
brief](../strategy/2026-06-competitiveness.md) calls for a single
citable public-leaderboard number to break the chicken-and-egg
distribution problem. Two leaderboards fit agentkit's
differentiators:

| Axis            | Leaderboard          | Status                                                            |
|-----------------|----------------------|-------------------------------------------------------------------|
| Memory          | LongMemEval-500      | Harness ready ([`longmemeval-500-pending.md`](longmemeval-500-pending.md)) |
| Code-mode       | SWE-bench-lite-class | This page; harness skeleton at `examples/benchmarks/swe-bench-lite.mjs` |

This page is the code-mode entry. The first-mover hook is direct:
**Cloudflare Code Mode MCP** (the closest competitor to
`@agentkit-js/mcp-server`'s `createCodeModeServer()`) has published a
*token-savings* story but no *task-completion* number on a real
coding benchmark. Whoever publishes the first credible
SWE-bench-lite number on the code-mode dispatch shape owns the
citation slot for the next 6–12 months.

The strategy memo's L2 ("trade self-built numbers for
public-leaderboard numbers") + the brief's Direction 2 + the
empty-citation slot make this the highest-payoff benchmark to
land second, after LongMemEval-500.

## What the published report will contain

When the harness is run for publication, the output replaces this
preamble with five sections:

1. **Headline.** SWE-bench-lite resolved% per (answerer × dispatch
   shape) cell. The single-axis number a third-party comparison
   blog can cite without reading the rest.
2. **Pareto axes.** accuracy × USD/correct × p95 wall × J/correct,
   one row per cell. Renders to the same shape as the evals-runner
   reports for visual consistency.
3. **Bootstrap-token comparison.** code-mode vs direct-MCP at the
   benchmark's actual N-tools, alongside the Cloudflare Code Mode
   blog's published 1,000-token figure when N is comparable. We do
   not over-claim against numbers Cloudflare did not publish; we
   note the comparison shape and mark unfair comparisons explicitly.
4. **Cache-effectiveness.** Anthropic `cache_read_input_tokens` /
   `cache_creation_input_tokens` per task, so the prompt-cache
   discipline is visible (otherwise it appears as a wash).
5. **Per-category breakdown.** SWE-bench-lite tasks span six repos;
   the breakdown is published so a reader can see which repo's
   structure stresses code-mode dispatch hardest.

## Pre-publication CLI (placeholder)

```bash
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...

# Smoke first (offline, CI guard):
node examples/benchmarks/swe-bench-lite.mjs --smoke

# Pareto run when funded:
node examples/benchmarks/swe-bench-lite.mjs --report \
  --tasks=300 \
  --answerers=claude-sonnet-4-6,claude-haiku-4-5,gpt-4o-mini \
  --dispatch=codemode,direct \
  --output=docs/reports/swe-bench-lite-2026-XX-XX.md
```

## What this report does *not* claim

- It does not benchmark agentkit's framework face vs Vercel AI SDK
  / Mastra / LangGraph as agent frameworks. The benchmark is
  scoped to **dispatch shape**, with the same answerer model in
  both cells, so the comparison isolates the variable that is
  actually under test.
- It does not claim the agentkit code-mode dispatch is faster
  than any specific framework's tool-loop. The honest comparison
  is *bootstrap-tokens* + *task-completion* — two axes the chain
  of round-trips affects most directly.

## What we need before running

The pre-run checklist lives in the harness file's docblock:

- SWE-bench-lite dataset accessible (HuggingFace
  `princeton-nlp/SWE-bench_Lite`, 300 instances).
- Containerised test runner (no host execution).
- Cache-token plumbing on the answerer adapter.
- A 5-task dry run within ±10% of a known reference pass-rate.

When all five gates are green and the API budget is committed, the
run produces this page. Until then, the file stays as a placeholder
+ a clear pointer to the harness, exactly the same pattern as
[`longmemeval-500-pending.md`](longmemeval-500-pending.md).

## Tracking

This page links from
[`docs/strategy/leaderboard-plan.md`](../strategy/leaderboard-plan.md)
("the public-benchmark plan"). When the report is published, the
plan's "Status" table flips and this preamble is replaced with the
actual numbers in the same git commit.
