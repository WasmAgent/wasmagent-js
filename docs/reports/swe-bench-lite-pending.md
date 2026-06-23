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
distribution problem. Two leaderboards fit WasmAgent's
differentiators:

| Axis            | Leaderboard          | Status                                                            |
|-----------------|----------------------|-------------------------------------------------------------------|
| Memory          | LongMemEval-500      | Harness ready ([`longmemeval-500-pending.md`](longmemeval-500-pending.md)) |
| Code-mode       | SWE-bench-lite-class | This page; harness skeleton at `examples/benchmarks/swe-bench-lite.mjs` |

This page is the code-mode entry. The first-mover hook is direct:
**Cloudflare Code Mode MCP** (the closest competitor to
`@wasmagent/mcp-server`'s `createCodeModeServer()`) has published a
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

- It does not benchmark WasmAgent's framework face vs Vercel AI SDK
  / Mastra / LangGraph as agent frameworks. The benchmark is
  scoped to **dispatch shape**, with the same answerer model in
  both cells, so the comparison isolates the variable that is
  actually under test.
- It does not claim the WasmAgent code-mode dispatch is faster
  than any specific framework's tool-loop. The honest comparison
  is *bootstrap-tokens* + *task-completion* — two axes the chain
  of round-trips affects most directly.

## What we need before running

The pre-run checklist lives in the harness file's docblock; gate-by-gate
status as of 2026-06-13:

- ✅ **SWE-bench-lite dataset accessible.** `loadTasks(count)` paginates
  `princeton-nlp/SWE-bench_Lite` via the HuggingFace datasets-server
  API, caches to `.cache/swe-bench-lite/test.json`. Verify live with
  `node examples/benchmarks/swe-bench-lite.mjs --load-tasks=3`.
- ✅ **Containerised test runner.** `runTests(task, patch)` builds
  `examples/benchmarks/judge/Dockerfile` on first call and runs
  `docker run --rm -v $tmp:/work WasmAgent-swe-judge:latest`. The
  judge (`judge.py`, ~250 lines) clones at `base_commit`, applies
  `test_patch` + the agent patch, runs pytest per node-id from
  `fail_to_pass` ∪ `pass_to_pass`, writes `result.json`.
  `.github/workflows/swe-bench-judge.yml` exercises the docker
  round-trip on a 1-task empty-patch case for $0 (workflow_dispatch).
- ⚠️ **Cache-token plumbing on the answerer adapter.** Stub-mode
  answerers in `dispatchCodemode` / `dispatchDirect` are wired and
  testable; real-mode (Anthropic / OpenAI) throws a clear "not
  wired yet" error. Lands when funded API access does.
- ⚠️ **A 5-task dry run within ±10% of a known reference pass-rate.**
  Blocked on the previous gate — needs the real-mode answerer.

When the two remaining gates are green and the API budget is
committed, the run produces this page. Until then, the file stays
as a placeholder + a clear pointer to the harness, exactly the
same pattern as
[`longmemeval-500-pending.md`](longmemeval-500-pending.md).

The `--smoke` exerciser (26 offline checks, 0 network, 0 docker
required) is a CI-friendly regression guard that the wiring stays
intact while we wait on funding.

## Tracking

This page links from
[`docs/strategy/leaderboard-plan.md`](../strategy/leaderboard-plan.md)
("the public-benchmark plan"). When the report is published, the
plan's "Status" table flips and this preamble is replaced with the
actual numbers in the same git commit.
