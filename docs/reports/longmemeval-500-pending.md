# LongMemEval-500 — multi-observer report (PENDING)

> **Status: harness ready, full run pending.** This file exists so the
> path the published report will land at is fixed and discoverable.
> The actual numbers will replace this preamble once the full run is
> funded; the harness lives at
> [`examples/benchmarks/longmemeval-500.mjs`](../../examples/benchmarks/longmemeval-500.mjs)
> and is tested in CI via `--smoke` mode.

## Why a placeholder

Mastra's public 94.87% on LongMemEval (gpt-5-mini observer) is the
single most visible memory-system number in the 2026 TS-agent
landscape. The WasmAgent reply has to be on the same dataset, with a
methodology that emphasises:

1. **Multi-observer comparison.** Mastra's third-party review
   (2026-03) flagged Claude 4.5-class incompatibility as a weakness.
   The WasmAgent observer is a regular Model adapter, so we report
   ≥2 Anthropic observers head-to-head against an OpenAI baseline.
2. **Multi-session subcategory.** The same review flagged a ~7 pp
   drop on multi-session questions vs. the headline. The
   `--report` table breaks out every LongMemEval category so we can
   see the same drop (or not) for each observer.
3. **Token + cache-hit per question.** Anthropic's API exposes
   `cache_read_input_tokens` and `cache_creation_input_tokens` on
   every call; the harness sums them. Stable observer prefixes
   should make this number meaningful, and Mastra has not published
   a comparable axis.

## What the published report will contain

Replace the contents of this file with the output of:

```bash
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
node examples/benchmarks/longmemeval-500.mjs --download
node examples/benchmarks/longmemeval-500.mjs --report \
  --answerer=gpt-4o-mini --answerer-base=https://api.openai.com/v1 \
  --observers=claude-haiku-4-5,claude-sonnet-4-6,gpt-4o-mini \
  --questions=500 \
  --price-in=0.15 --price-out=0.60 \
  --output=docs/reports/longmemeval-500-2026-06-12.md
```

The output replaces this preamble with three sections:

- **Headline** — accuracy + total tokens + cache-read tokens + USD per
  observer.
- **Per category** — multi-session, single-session-user, multi-session,
  knowledge-update, temporal-reasoning, long-context, plus any
  others present in the official set; one column per observer.
- **Reproducibility** — the exact CLI invocation that produced the
  table, so the next run is one command.

## Funding gate

The 500-question × ≥2-Anthropic-observer × OpenAI-answerer matrix is
flagged 🖥️ in [ROADMAP.md](../../ROADMAP.md) and the [strategy
memo](../strategy/2026-06-competitiveness.md#strategic-lines) — the
single highest-leverage benchmark we can fund, and the one we have
not yet funded. Estimated cost at 2026-06 published rates is in the
tens of USD (the answerer is the dominant cost; observers compress
to a small summary so their token spend is bounded).

If you are reading this and would like to underwrite the run, open
an issue tagged `benchmark:fund` — the deliverable is this file
replaced with the populated report, plus a commit to README's
"Verified status" table linking to it.

## In the meantime

The 5-model 17×-size-range comparison from 2026-06-12 is the closest
public artefact we have. It uses LongMemEval-style fixtures rather
than the official 500 set, but the same methodology shape (Pareto +
McNemar + Wilson) — see
[`longmemeval-5model-2026-06-12.md`](longmemeval-5model-2026-06-12.md).
