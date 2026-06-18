# Public-Benchmark Plan — leaderboard-citable numbers

> Last refreshed: **2026-06-12**.
> Direction 2 of the 2026-06-12 optimization brief.
> Companion to [`2026-06-competitiveness.md`](2026-06-competitiveness.md)
> (L2: "trade self-built numbers for public-leaderboard numbers").

## Why this file exists

Mastra leveraged **one** number — 94.87% on LongMemEval — into the
entire 2026-Q1 press cycle for the framework. Cloudflare Code Mode
MCP sells *purely* on a token-savings story with no task-completion
number behind it. agentkit-js has the technical foundation to land
both flavours of leaderboard number, but at 2026-06-12 has neither
on the README's "Verified status" table.

This page is the prioritised plan for changing that, with a
single-table status row per axis so a reader can tell at a glance
whether we are still in "in-flight" or "published."

## Status table

| Axis            | Leaderboard / dataset                   | Harness                                                                                                          | Placeholder report                                                                              | Status                                              |
|-----------------|-----------------------------------------|------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------|-----------------------------------------------------|
| Memory          | [LongMemEval-500](https://github.com/xiaowu0162/LongMemEval) | [`examples/benchmarks/longmemeval-500.mjs`](../../examples/benchmarks/longmemeval-500.mjs)                       | [`docs/reports/longmemeval-500-pending.md`](../reports/longmemeval-500-pending.md)              | 🟡 harness ready, run funding-dependent (🖥️)     |
| Code-mode       | SWE-bench-lite (300 tasks)              | [`examples/benchmarks/swe-bench-lite.mjs`](../../examples/benchmarks/swe-bench-lite.mjs) (all 5 slots filled — `loadTasks`, `dispatchCodemode`, `dispatchDirect`, `runTests` container judge, `reportPareto`; 26-check `--smoke`) | [`docs/reports/swe-bench-lite-pending.md`](../reports/swe-bench-lite-pending.md)                | 🟡 harness ready, real-mode answerer + funded API run remaining |
| Pareto cost     | LongMemEval × evals-runner stats        | [`@wasmagent/evals-runner`](../../packages/evals-runner/) + the harness above                                 | inline in the LongMemEval-500 report                                                            | 🟡 ready alongside the LongMemEval headline         |

🟢 published | 🟡 ready, awaiting budget | 🟠 in-flight design

## Why these two leaderboards, in this order

### 1. LongMemEval-500 — the *defensive* citation

The number to beat / explain is **Mastra 94.87%** (gpt-5-mini
observer, 2026-02). Two third-party reviews flagged the
multi-session sub-category and Claude-4.5 incompatibility as
weaknesses. The agentkit observer is a regular Model adapter, so
multi-observer comparison ships for free, and `ObservationalMemory`
keeps the observer prompt byte-stable so prompt-cache hits compound.

The published report will lead with the headline number on the same
500-question set, immediately drop into a per-category breakdown
(multi-session called out explicitly), then add a
prompt-cache-hit-per-question column Mastra has not published. The
defensive value is "we are on the same dataset, not a private
trace"; the offensive value is the cache-hit column.

### 2. SWE-bench-lite-class code-mode dispatch — the *offensive* citation

There is no published task-completion number for **any** code-mode
dispatch pattern on a real coding benchmark. Cloudflare Code Mode
MCP (closest competitor to `@wasmagent/mcp-server`) sells on the
1,000-token bootstrap savings — a real story, but one that does not
answer the buying question of *does the agent actually solve more
issues?*

Whoever publishes the first credible SWE-bench-lite number on the
code-mode dispatch shape owns the citation slot until the next
entrant. agentkit's `createCodeModeServer()` is shipping; the
harness in
[`examples/benchmarks/swe-bench-lite.mjs`](../../examples/benchmarks/swe-bench-lite.mjs)
is the skeleton.

The offensive value is *first-mover citation* on a buying-question
axis. The risk is that the run lands and the number is mediocre —
in which case the report still publishes (per the strategy memo's
"no private benchmarks" rule), and the Pareto framing keeps the
result honest by surfacing cost / latency / cache axes the
single-number leaderboard suppresses.

## What we will not do

- **Self-built single-axis numbers.** Per the strategy memo, no
  README percentage that cannot be reproduced from a public
  dataset survives the next refresh. The `examples/benchmarks/`
  numbers stay as offline accounting (token-savings, scaling
  curves) — *not* as adoption-pitch citations.
- **Run for publication before the pre-run checklist.** Both
  pending reports list the gates that have to be green before the
  publication run is funded. Skipping a gate to ship a number
  fast is exactly how a leaderboard claim becomes a follow-up
  retraction.
- **Cite Cloudflare's unpublished SWE-bench number.** They have
  not published one. Comparing against an absence is a tell;
  comparing against their **published** token-savings figure on
  matched-N is fair and what the report will do.

## Falsifiability

If the LongMemEval-500 run lands and we are below ~85% across the
multi-observer comparison, **the strategy memo's L2 is wrong** and
this plan needs to be re-thought. The ObservationalMemory benchmark
in `examples/benchmarks/observational-memory.mjs` reports 22% of
baseline tokens (4.5× compression), but compression alone does not
buy accuracy — accuracy is a separate gate. We will publish either
result.

If the SWE-bench-lite run lands and code-mode dispatch is *worse*
than direct-MCP on resolved%, the right answer is to publish that
finding too. The strategy memo's Direction 1 ("become the embedded
runtime") does not require code-mode to win on every axis — it
requires us to be *honest* on every axis, so the upstream
maintainers we are trying to land in can trust our numbers.

## Where this plan goes next

When the LongMemEval-500 run is funded:

1. Run the harness; replace `longmemeval-500-pending.md` with the
   real numbers in the same git commit.
2. Add the headline to the README's "Verified status" table.
3. Update the status row in this file from 🟡 → 🟢.
4. Add a row to the bi-weekly release ledger
   ([`release-cadence-log.md`](release-cadence-log.md)) referencing
   the report.
5. Cite from the strategy memo's "Watch [evals reports]" line.

When the SWE-bench-lite run is funded, same flow, with the added
step of pinging the Cloudflare codemode docs maintainer so the
upstream-prs draft
([`upstream-prs/cloudflare-codemode-byo-executor.md`](upstream-prs/cloudflare-codemode-byo-executor.md))
can land with the number attached. A merged executor recipe page
*plus* a published SWE-bench-lite number on that executor is the
strongest combined signal Direction 1 + Direction 2 can produce.
