# Memory eval suites — placeholder for the live run

This directory will hold the markdown reports from running the
`locomo-refined` and `memory-agent-bench` suites against real models.
The suites themselves live at:

- `packages/evals-runner/src/suites/locomo-refined.ts`
- `packages/evals-runner/src/suites/memory-agent-bench.ts`

## Status (2026-06-14)

- ✅ Suites implemented + barrel-exported
- ✅ Strict-judge stand-in (forbidden-substring check) unit-tested
- ⏳ Live model runs **deferred** — host is currently running the
  evomerge `p17_b1_sft.py` SFT job (PID 98361 as of 2026-06-14
  ~13:00, expected to take several more hours). Running additional
  LLM inference now would compete for the same Apple Silicon
  unified memory pool and slow both jobs.

## When the host is free

```bash
# Build the runner
bun run -F '@wasmagent/evals-runner' build

# Run both suites against whatever models you want to compare:
node examples/benchmarks/eval-runner.mjs \
  --base-url http://localhost:11434/v1 \
  --models qwen2.5:0.5b,evomerge-qwen25-1b5:latest,evo-qwen3-1b7-q3km:latest \
  --suites locomo-refined,memory-agent-bench \
  --seeds 0,1,2 \
  --out docs/reports/memory-eval-2026-06-14
```

Wall: ~30-60 minutes depending on which models are tested. The
`locomo-refined` items are short multi-turn histories (~30 turns); the
`memory-agent-bench` items are longer (~50 turns) due to noise padding.

## Scope of the suites

These suites are **synthetic stand-ins**, not redistributions of the
licence-encumbered original datasets:

- **`locomo-refined`** — 10 items across 5 categories (single-hop /
  multi-hop / temporal / open-domain / adversarial), with a
  `forbidden-substring` strict-judge stand-in for the Qwen3-14B
  judge introduced by mem-eval-suite/LoCoMo_refined (April 2026).
  The original benchmark has 1,382 items; ours has 10. Use ours
  for sanity-checking a memory-equipped agent before plugging in
  the real dataset.

- **`memory-agent-bench`** — 20 items across 4 competencies (AR /
  TTL / LRU / CR), modelled on HUST-AI-HYZ/MemoryAgentBench
  (ICLR 2026). Same caveat: the real dataset is much larger; this
  is for pipeline validation.

When publishing numbers externally, use the real datasets via their
official scripts; cite the synthetic versions only as smoke tests.

## Why the strict-judge stand-in

LoCoMo's original LLM judge agreed with humans only ~44% of the time,
which is why the field rebuilt it. We can't ship a Qwen3-14B judge
inside WasmAgent (size + dependency cost), so we use a deterministic
forbidden-substring check. It's not a perfect proxy — a real strict
judge can recognize "the user said vegan, model said vegetarian-but-with-cheese"
as a logical inconsistency that no string match catches — but it
does catch the dominant failure mode (forbidden token leaking into
the answer alongside the right one).

For the cases where this matters (publishing public numbers), wire in
the `judgeScorer` from `@wasmagent/core`'s evals module pointed at
a stronger judge model. The forbidden-substring check is the
deterministic CI-friendly fallback.
