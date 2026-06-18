# Multi-Turn Scaffold Ablation — V2 Report (2026-06-13)

> Status: **harness shipped + end-to-end smoke green**. The full 5-arm × 5-model × 3-seed × 30-item production run is documented below as a reproduction recipe; it was deliberately deferred from this commit because the host machine was time-shared with a parallel evomerge GSM8K lm_eval pass and a SFT job. Running it requires only a free Ollama and ~8 wall-clock hours.

## What V2 ships

| Component | Path | Purpose |
|---|---|---|
| `BenchmarkSuite.runItem` hook | `packages/evals-runner/src/types.ts` | Lets a suite take ownership of cell execution (the V1 single-call path can't drive a real agent loop). |
| `multi-turn-tool-exec` suite | `packages/evals-runner/src/suites/multi-turn-tool-exec.ts` | 30 stateful items across FS / calendar / cart / mixed fixtures, judged by terminal-state diff (BFCL-v3 protocol). |
| 5 ablation arms | `packages/evals-runner/src/suites/multi-turn-scaffold-arms.ts` | Bare ToolCallingAgent / +grammar / CodeAgent+QuickJSKernel / +SC k=5 / full stack. |
| Driver script | `examples/benchmarks/multi-turn-scaffold-ablation.mjs` | Walks the arm × model × seed grid, paired-McNemar each non-bare arm against bare per model, writes markdown + JSON. |
| Aggregation fix | `packages/evals-runner/src/runner.ts` | `buildAggregates` now filters cells by `traceId` (`::${suite.name}::`) instead of item-id membership — V2 surfaced that two suites sharing item IDs were double-counting. |

## End-to-end smoke (this commit)

```text
$ node examples/benchmarks/multi-turn-scaffold-ablation.mjs \
    --models qwen2.5:0.5b --arms bare,grammar --seeds 0 --limit 3 \
    --concurrency 1 --no-warmup --out /tmp/abl-smoke3

[ablation] 6/6 last=qwen2.5:0.5b/fs-2step-write/✓ (979ms)
qwen2.5:0.5b × mt-tool-exec.arm-a-bare:    meanAcc=33.3%  pooled=1/3  Wilson=[6.1, 79.2]  p95Wall=1072ms
qwen2.5:0.5b × mt-tool-exec.arm-b-grammar: meanAcc=66.7%  pooled=2/3  Wilson=[20.8, 93.9] p95Wall=2358ms
McNemar: grammar vs bare on qwen2.5:0.5b → arm-wins=1 bare-wins=0 both=1 neither=1
```

Six cells across two arms, real `ToolCallingAgent` loop, real Ollama
inference, real terminal-state judge. Wilson CIs are wide because
n=3 — the smoke validates *wiring*, not effect size.

## Production reproduction (~8h, single 16GB laptop, no dGPU required)

Models — registry aliases + evomerge candidates already in your
local Ollama, plus an API control that goes through
`GenericOpenAICompatModel`:

```bash
# Pre-condition: Ollama is up, models are pulled.
ollama pull qwen2.5:0.5b
ollama pull qwen3:0.6b           # or any 0.6B GGUF you have
ollama pull qwen2.5:1.5b
# Plus your distilled candidates already on this machine:
#   evomerge-qwen25-1b5:latest          (Stage-0 ≤2GB winner, Q8_0)
#   p17-c3-imat_A_gsm512:latest         (C3 imatrix winner, Q3_K_M)
#   p17-c3-baseline_clean100:latest     (C3 baseline)

bun run -F '@wasmagent/evals-runner' build

node examples/benchmarks/multi-turn-scaffold-ablation.mjs \
  --base-url http://localhost:11434/v1 \
  --models qwen2.5:0.5b,qwen3:0.6b,qwen2.5:1.5b,evomerge-qwen25-1b5:latest,p17-c3-imat_A_gsm512:latest,p17-c3-baseline_clean100:latest \
  --arms bare,grammar,code,self-consist,full \
  --seeds 0,1,2 \
  --concurrency 1 \
  --out docs/reports/multi-turn-scaffold-ablation-2026-06-13
```

Output:
- `docs/reports/multi-turn-scaffold-ablation-2026-06-13/report.md` — markdown grid with per-(model, arm) Wilson + McNemar columns.
- `docs/reports/multi-turn-scaffold-ablation-2026-06-13/raw.json` — full trace per cell, ready for re-aggregation / Pareto plotting.

## Reading the report — the G0 question

The desktop-agent feasibility plan (2026-06-13) defines G0 as:

> Any ≤2B / ≤1.2GB model under arm (e) full-stack achieves
> `multi-turn-tool-exec` ≥ 50%, AND McNemar p < 0.05 vs bare arm (a).

Decision logic when the production run lands:
- **Pass** → enter Phase 1 (D1: bsagent-desktop new repo at `/Users/I041705/github/bsagent-desktop`). The report is also the public artifact P1 publishes.
- **Fail** → no app code yet. Feed the report back to the evomerge / SFT track for targeted training (xLAM-2 1B took multi-turn from ~8% to 35%); retest in 3 months. V1 (the suite) and V3 (the cert pipeline + sha256) are not sunk cost in either branch.

## Arm semantics — single-line each

| Arm | Stack | Hypothesis tested |
|---|---|---|
| (a) bare | `ToolCallingAgent` maxSteps=15 | Baseline — what does the model do unaided? |
| (b) grammar | (a) + Ollama `format=json` | Form-level legality is the dominant failure (BFCL findings). |
| (c) code | `CodeAgent` + `QuickJSKernel`, maxSteps=8 | Compress N round-trips into one program block (CodeAct, MS Agent Framework 2026-04). |
| (d) self-consist | (a) k=5, majority on terminal state | Stochastic noise is the dominant failure (free at local-zero token cost). |
| (e) full | (b) + (c) + (d) + ObservationalMemory | The "everything we can throw" arm; the G0 candidate. |

## Caveats

- Arm (b)'s grammar uses Ollama's `format: "json"` (any JSON), not a per-tool JSON schema. The latter is supported by Ollama v0.5+ but adds a per-tool schema construction step we can layer on if (b) shows a meaningful gap; for now the simpler global JSON constraint already captures the form-level failure mode the BFCL paper cites.
- Arm (c) uses `CodeAgent` + `QuickJSKernel` in CodeAct shape. The plan also mentions `ProgrammaticOrchestrator`; in the agentkit-js architecture, `CodeAgent` IS the user-facing surface for PTC (it owns its own kernel and the orchestrator is plumbing). The behaviour is identical; we noted the path explicitly here.
- Arm (e)'s `ObservationalMemory` is what every `ToolCallingAgent` already uses for its assembler — there's no "off" mode to compare against, so we don't add a separate knob. (If you want to ablate it specifically, swap the assembler at `agent.assembler` post-construction; not needed for the G0 measurement.)

## DoD vs the plan (V2)

- ✅ `multi-turn-scaffold-ablation.mjs` walks 5 arms × N models × seeds × items
- ✅ Each arm × model × seed paired against bare via `mcnemarExact` (already in `packages/evals-runner/src/stats/mcnemar.ts`)
- ✅ Report falls under `docs/reports/multi-turn-scaffold-ablation-<date>/` (this file + `report.md` from the script)
- ✅ Smoke run included in the report so the wiring is provably end-to-end
- ⏳ Full grid (≥3 seeds × every arm × every model) — left as the documented reproduction recipe; running it on this host now would conflict with the parallel evomerge job.
- ⏳ Pareto front on (accuracy × p95 wall × model size) — `runEvaluation` already builds the first two axes; size is the human-supplied third axis (Ollama tags don't expose model size). Add `--sizes a=mb,b=mb,...` to the script to render that axis if needed.
