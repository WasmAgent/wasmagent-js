# Multi-Turn Scaffold Ablation — Public Report (skeleton)

> **Status: skeleton — to be filled with the production V2 numbers
> when the deferred grid run lands.** This document satisfies the P1
> step of the desktop-agent feasibility plan (2026-06-13) and is the
> piece that maps the internal multi-turn-tool-exec result to the
> public BFCL-v3 multi-turn subset (the figure the ROADMAP S2 strategy
> is set up to consume).

## Headline (TBD)

> Bare ToolCallingAgent on a 1.5B local model: **N1%** on
> `multi-turn-tool-exec` (30 stateful items, terminal-state judge).
> agentkit-js full scaffold (grammar + CodeAgent + SC k=5): **N2%**.
> Improvement Δ = **N3 pp**, McNemar exact p = **N4**.

## Agentkit-side reproduction (tracks V2 REPORT.md)

```bash
git clone https://github.com/<org>/agentkit-js
cd agentkit-js
bun install
bun run -F '@wasmagent/evals-runner' build

# Pull the same models we used (Stage-0 ≤2GB winner + community baselines)
ollama pull qwen2.5:1.5b
ollama pull qwen3:0.6b
ollama pull gemma3:1b
ollama pull llama3.2:1b
ollama pull qwen2.5:0.5b

node examples/benchmarks/multi-turn-scaffold-ablation.mjs \
  --base-url http://localhost:11434/v1 \
  --models qwen2.5:0.5b,qwen3:0.6b,qwen2.5:1.5b,gemma3:1b,llama3.2:1b \
  --arms bare,grammar,code,self-consist,full \
  --seeds 0,1,2 \
  --out docs/reports/p1-public-ablation
```

Wall-clock: ~6h on a 16GB M-series laptop, no dGPU required. The
report is markdown + raw JSON.

## BFCL-v3 multi-turn cross-run (TBD)

The cross-run plan, lifted from the feasibility plan §2.P1:

```bash
pip install bfcl-eval
bfcl generate --model openai/qwen2.5:1.5b@http://localhost:11434/v1 \
  --test-category multi_turn_base \
  --num-threads 4
bfcl evaluate --test-category multi_turn_base --model qwen2.5:1.5b
```

Two arms only (bare vs full agentkit scaffold) to control budget;
the internal report gives the wider grid.

When the BFCL run completes, append the per-category numbers below
and submit a leaderboard row.

## What this report claims (and what it doesn't)

**Claims:**
- A 1.5B model + framework-only scaffolding can / cannot match
  3B-scale specifically-trained function-calling models on multi-turn
  tasks. (Fill in the answer once the run lands.)
- The proportion of failure that is form-level vs reasoning-level
  (gap between arm (b) grammar and arm (a) bare).
- The marginal value of CodeAct-style turn compression at this scale
  (gap between arm (c) and arm (a)).

**Does not claim:**
- That the same arm gradient holds at 3B+ — those experiments live
  upstream of this scope and are reported separately.
- That the full stack matches API-grade models on BFCL-v3 multi-turn
  *without* RL-trained agent loops; the headline is calibrated to the
  consumer-laptop deployment story, not to the absolute frontier.

## Why a public report at this stage

ROADMAP S2 ("public leaderboard numbers replace self-reported
numbers"). BFCL-v3's multi-turn split is the canonical public
artifact for the multi-turn function-calling axis as of 2026-06; no
known competitor (Cloudflare Code Mode, Anthropic Workbench, etc.)
has published numbers in the same shape. First-mover citation
position is non-trivial — see the SWE-bench-lite move from the same
ROADMAP for the analogous logic.
