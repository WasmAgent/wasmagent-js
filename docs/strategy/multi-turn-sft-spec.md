# Multi-turn Tool-Exec SFT Spec — agentkit-js → evomerge hand-off

> **Audience**: the evomerge contractor team / future Claude instance
> working in `/Users/I041705/github/evomerge` under that repo's
> `CLAUDE.md` constitution.
> **Source**: this is the path-1 fallback the
> `Downloads/desktop-agent-feasibility-plan.md` failure branch invoked,
> after Run F + Run G (2026-06-13) confirmed scaffold-only at ≤2B
> caps Wilson-upper at 42.4% — 8pp short of the G0 50% threshold.
> **Version**: v1, 2026-06-13.

## 1. What this asks for, in one paragraph

Take a 1.5B–1.7B Qwen base (e.g. `evomerge-qwen25-1b5` or
`evo-qwen3-1b7-q3km`, both already in evomerge's local Ollama
catalogue), do a **cold-start LoRA SFT** on synthetic multi-turn
tool-execution traces, and ship a LoRA adapter whose evaluation on
the V1 multi-turn-tool-exec ruler **clears 50% pooled accuracy**
under arm-f param-only with McNemar p<0.05 against the same base
model unadorned. **Locality non-regression on GSM8K / IFEval / MMLU
must each stay within evomerge CLAUDE.md §0.3's ±1.0pp band.**
Below: data, framework, gates, deliverables.

## 2. Why this is the natural evomerge work

Mapped onto evomerge CLAUDE.md:

- **§0.2 第一类 vs 第二类**: multi-turn tool-call failure is a
  **mixed-class** defect. The failure analysis below isolates
  three concrete second-class symptoms that respond to short-trace
  SFT (xLAM-2 1B precedent: ~8% → 35% multi-turn after targeted
  SFT). Per §0.2, training is a sanctioned means since 2026-06-12;
  this work fits inside that authorisation.
- **§0.3 Locality**: GSM8K + IFEval + MMLU each ±1.0pp band is
  hard-required. Multi-turn data is out-of-domain for those three;
  expected drift is downward and must be measured + bounded.
- **§0.4 Statistical discipline**: ≥3 seeds, Wilson CI, McNemar
  paired exact. The ruler at the bottom of this doc is built that
  way.
- **§0.6 Three-stage order**: this is a **Stage 1 (surgical
  repair)** product. It runs against an already-quantized client
  base; on success it goes through Stage 3 (post-quant re-eval) to
  confirm the LoRA holds under the customer's quant.
- **§0.8 G3 data isolation**: explicit. Train/val/eval splits are
  pre-partitioned in the dataset, with overlap manifest. No
  retraining on V1 ruler items.
- **§0.9 FROZEN lines**: this work is on the **branch-1 SFT line**
  (per `p17_b1_sft.py`), not the moat / multi-parent merge lines
  that are frozen. Compatible with the freeze.

## 3. The eval target — what "success" measures against

**The ruler is `@agentkit-js/evals-runner`'s
`multi-turn-tool-exec` suite + arm-f param-only**, both already
implemented and validated in:

- `packages/evals-runner/src/suites/multi-turn-tool-exec.ts` — 30
  stateful items across FS / calendar / cart / mixed fixtures,
  BFCL-v3-style terminal-state judge.
- `packages/evals-runner/src/suites/multi-turn-scaffold-arms.ts` —
  arm-f two-pass param-only (model picks tool name from grammar
  enum, then fills args under tool-specific JSON Schema).
- `examples/benchmarks/multi-turn-scaffold-ablation.mjs` — driver,
  emits `report.md` + `raw.json`.

**Runs against any OpenAI-compat endpoint via Ollama**:

```bash
node examples/benchmarks/multi-turn-scaffold-ablation.mjs \
  --base-url http://localhost:11434/v1 \
  --models <your-merged-model-tag> \
  --arms bare,param-only \
  --seeds 0,1,2 \
  --concurrency 1 \
  --no-warmup \
  --out outputs/multi-turn-eval
```

180 cells, ~30–45 min wall on Apple Silicon depending on model.
**This is the only eval we will accept for the G1 gate**; do not
substitute BFCL-v3 official, GSM8K, or any single-turn benchmark
as a stand-in.

## 4. Pre-work measurements (the floor to beat)

These are evomerge's **starting line** before any SFT — the bare
and arm-f numbers we measured on each candidate base. SFT lift is
quoted **on top of arm-f**, not on top of bare, because the
production deployment uses arm-f.

| Base model | bare (a) | arm-f param-only | Wilson 95% on f | McNemar (f vs a) |
|---|---:|---:|---|---|
| `evomerge-qwen25-1b5` (1.5B Q8_0)    | 0/90 (0.0%) | 22/90 (24.4%) | [16.7, 34.2] | p=4.8e-7 (Run F) |
| `evo-qwen3-1b7-q3km` (1.7B Q3_K_M)   | 0/90 (0.0%) | 29/90 (32.2%) | [23.5, 42.4] | p=3.7e-9 (Run G) |

**G0 PASS target** = arm-f Wilson lower bound clears 50% on at
least one of these bases. To satisfy that, the new point estimate
needs to be ≥56% (so the lower bound clears 50% at n=90 by Wilson
arithmetic) — i.e. SFT must contribute approximately **+24pp on
1.7B** or **+32pp on 1.5B**, on top of the scaffold's existing
contribution.

xLAM-2 1B literature precedent: targeted multi-turn SFT lifted a
1B model from ~8% to ~35% multi-turn (+27pp). On the same base,
that's the ballpark; cannot be assumed mechanically additive with
arm-f's scaffold lift.

## 5. Failure-mode breakdown (what the SFT data must teach)

V1 ruler item-level analysis on the 1.5B / 1.7B arm-f cells
identifies three concrete failure shapes. SFT data should
over-represent the corrective examples for each.

### 5.1 Path-shape errors (~35% of failures)

Model writes paths with `/` prefix (`/notes/draft.md`) but fixture
stores without (`notes/draft.md`). Tool returns "no such file";
model **does not learn from the error message** and retries the
same path 2-3 times before giving up.

**Training counterfactual**: a `tool` message containing
`{"error": "no such file: /notes/draft.md"}` should be followed by
an `assistant` turn that calls `list_files()` to discover paths,
NOT another `move_file()` with the same wrong path. Loss-weight
the recovery turn 2× standard.

### 5.2 Multi-turn state collapse (~30% of failures)

Model successfully calls tool 1, gets correct result, then on
turn 2 acts as if turn 1 never happened — re-reads the same file,
re-lists the same dir, never advances. The bare-arm 0/90 on
`evomerge-qwen25-1b5` is dominated by this mode.

**Training counterfactual**: traces where the assistant
**explicitly references** the prior tool result before the next
call:

```
{"role":"tool", "content":"{\"paths\":[\"a.txt\",\"b.txt\"]}"}
{"role":"assistant", "content":"Two files found: a.txt and b.txt. Now I'll move them..."}
{"role":"assistant", "tool_calls":[{"name":"move_file","arguments":"..."}]}
```

The intermediate text turn is the SFT signal — small models trained
on these transcripts learn to summarise prior state before acting.

### 5.3 Premature termination (~15% of failures)

Model emits `final_answer` after one successful tool call when the
task requires three. The grammar permits final_answer at every
step; the small model under-uses the multi-step pattern.

**Training counterfactual**: traces where the user task explicitly
requires N steps, and the assistant only emits `final_answer`
after all N have completed successfully.

### 5.4 Remaining ~20%

Mixed: malformed JSON args (now mostly grammar-suppressed by arm-f
but residual), wrong tool selection from the enum (1.5B sometimes
picks `read_file` when `list_files` was needed), and item-specific
artefacts. Less actionable for SFT; let the volume of (5.1)–(5.3)
training data drag these along.

## 6. Dataset format — what to build

JSONL, one object per line, schema:

```json
{
  "id": "mt-fs-2step-rename-seed42-v1",
  "split": "train" | "val" | "eval",
  "category": "fs-2step | cal-3step | cart-bulk | mixed-3step | recovery | premature-term",
  "messages": [
    {"role": "system", "content": "<ARM_F_SYSTEM_PROMPT verbatim from arms.ts:230>"},
    {"role": "user", "content": "Rename notes/draft.md to notes/final.md."},
    {"role": "assistant", "content": "I'll move the file.", "tool_calls": [
      {"id": "c1", "type": "function",
       "function": {"name": "move_file",
                    "arguments": "{\"from\":\"notes/draft.md\",\"to\":\"notes/final.md\"}"}}
    ]},
    {"role": "tool", "tool_call_id": "c1", "content": "{\"ok\":true}"},
    {"role": "assistant", "content": "DONE", "final_answer": true}
  ],
  "loss_weight_tokens": "default | recovery | state_summary",
  "provenance": {
    "source": "agentkit-js/v1-ruler-traces-v1",
    "v1_item_id": "fs-2step-rename",
    "n_gram_hash": "sha256:..."
  }
}
```

**Key constraints (read carefully)**:

1. **Tokenizer compatibility**: evomerge's `p17_b1_sft.py` calls
   `tokenizer.apply_chat_template(messages, ...)`. Qwen2.5's chat
   template natively handles `tool_calls` + `tool` role messages
   when `add_generation_prompt` is set correctly. **No custom tool
   tokens, no `<tool_calls>` / `</tool_calls>` delimiters** — those
   would break Ollama serving and quant.
2. **Loss masking**: only assistant tokens contribute to loss
   (consistent with `p17_b1_sft.py:55-72`'s label-masking pattern).
   `tool` and `user` and `system` tokens are masked to `-100`.
3. **Per-token loss weight**: `loss_weight_tokens` field describes
   which schema applies — `default` = uniform 1.0; `recovery` =
   2.0× on tokens within the assistant turn that immediately
   follows a `tool` turn with `"error"`; `state_summary` = 1.5× on
   the natural-language summary turn before a tool call. Optional;
   evomerge can ignore and use uniform weights — spec'd here so the
   data file is forward-compatible.
4. **Item-level provenance**: every `provenance.v1_item_id` MUST
   match an actual V1 ruler item id. The G3 isolation gate then
   reduces to "does the eval set re-use any v1_item_id used in
   training" — straightforward set-difference check.

### 6.1 Volume + split

| Split | Items | Source | Use |
|---|---:|---|---|
| `train` | ~2000 | Synthetic teacher rollouts (Qwen3-8B as teacher), seeded with V1-fixture-shaped tasks but **different surface forms** (different filenames, different paths, different event titles) | LoRA SFT |
| `val` | 200 | Same generator, held out from training | Hyperparameter sweep, early-stop signal |
| `eval` | 200 | **Fresh-generated, never seen during data prep**; uses NEW fixture surface forms not in train or val | Final G1 number; never look at this during training |

**The 30-item V1 ruler is NOT the eval set in this protocol** — it
is the fixed external benchmark used after training. The 200-item
eval set above is for the G1 power calculation evomerge runs
internally; the V1 ruler is the user-facing acceptance test.

### 6.2 Starter dataset (this commit ships)

`agentkit-js/datasets/multi-turn-sft-starter/` (this commit):

- `train_seed.jsonl` — **40 hand-rolled records** demonstrating the
  schema, distributed across V1 families: 13 `fs-*`, 7 `cal-*`, 8
  `cart-*`, 3 `mixed-3step`, 6 `recovery`, 3 `premature-term`. The
  recovery records explicitly stage the path-shape failure mode
  (assistant calls `list_files` after a "no such file" error
  instead of retrying); the premature-term records show
  multi-tool-call sequences ending in `final_answer` only after
  all steps succeed; the canonical records show clean
  state-summary narratives between tool calls.
  21 records reference real V1 item ids (`provenance.v1_item_id`
  matches the V1 ruler item exactly — these are SFT examples for
  V1 items the model is expected to fail on). 19 records use
  synthetic ids (`synth-*`) — variants with new filenames /
  events / SKUs that should NOT be considered V1-overlap during
  G3 isolation.
- `generate.mjs` — the generator script. Re-run idempotently;
  output is deterministic (no `Math.random`, all paths/contents
  are literal). Audit-friendly.
- `SCHEMA.md` — schema doc, copy of §6 above.
- `validate.mjs` — read-only validator that checks each line
  against the schema and prints per-category counts. Run before
  shipping any larger version.

The 40-item seed exists so evomerge can plug it into
`p17_b1_sft.py --train-data <path>` and verify the pipeline
end-to-end before scaling data generation. **It is not large
enough for actual training** — the LoRA rank=16 on Qwen2.5-1.5B
needs ~2k items minimum to learn anything generalisable. Treat
the 40 as a **schema test fixture + failure-mode exemplar**, not
as a training corpus.

## 7. Framework integration — what to use, what to avoid

**Reuse, do not invent**:

- **Trainer**: `scripts/p17_b1_sft.py` — already implements LoRA
  SFT on `Qwen2.5-1.5B-Instruct`. Args: `--rank`, `--lr`,
  `--epochs`, `--batch`, `--max-seq-len`, `--train-data`. The
  `messages`-format collator is already compatible with the schema
  in §6 (it calls `apply_chat_template`).
- **Drift guard**: `src/evomerge/eval/finetune_monitor.py` — the
  KL-drift HF Trainer callback. Wire it in for early-stop on
  GSM8K drift > 1.5pp during training.
- **Gates**: `src/evomerge/eval/gates.py` (per evomerge CLAUDE.md
  §0.4) — G1 McNemar exact, G2 locality (GSM8K + IFEval + MMLU),
  G3 isolation. Use as-is.

**Hyperparameter starting point** (mirror `p17_b1_sft.py`
defaults, modify only the marked fields):

| Param | Value | Reason |
|---|---|---|
| `rank` | 16 | Same as p17 baseline |
| `lora_alpha` | 32 (= 2× rank) | Same |
| `target_modules` | `q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj` | Same |
| `lr` | 1e-4 | **Slightly lower than p17's 2e-4** because multi-turn data is more diverse and we want to avoid catastrophic forgetting on locality |
| `epochs` | 3 | Same |
| `batch` | 2 | Same (memory-bound) |
| `max_seq_len` | **2048** | **Higher than p17's 768** — multi-turn traces can be long; truncating breaks the pattern |
| `save_steps` | 100 | **Frequent checkpointing** — multi-turn SFT will be slow; do not lose progress on a crash |

**Do not**:

- Add custom tool tokens to the tokenizer (would break quant + Ollama).
- Use a different chat template (Qwen2.5's native one handles
  tool_calls correctly when `apply_chat_template(messages,
  tools=tools, add_generation_prompt=False)` — we need the `tools`
  arg passed; this is the one place `p17_b1_sft.py` may need a
  small patch).
- Train from a non-quantized base then re-quantize — Stage 3 of
  CLAUDE.md §0.6 must apply. The customer's deployment is the
  q4_k_m quant; the LoRA must demonstrate it survives quant.

## 8. Three-gate acceptance — what we will check

This adapts evomerge CLAUDE.md §0.4 / §0.6 / §0.8 to the multi-turn
domain. We will run all three gates ourselves on the returned
artefact.

### G1 — Powered, paired, primary metric

- **Metric**: V1 ruler arm-f pooled accuracy at n=90 (3 seeds × 30
  items) using the script in §3.
- **Test**: McNemar exact paired against the same base model
  WITHOUT the LoRA, on the same items × same seeds.
- **Pass condition**: pooled accuracy ≥56% (so Wilson lower bound
  clears 50% at n=90), McNemar p < 0.05, **AND** at least 5
  arm-wins per family (FS / cal / cart / mixed / 4-step) — no
  single-family wins masking total failure elsewhere.
- **Fail surface**: any of the three. Re-train with adjusted data
  mix.

### G2 — Locality

- **Metric**: GSM8K, IFEval, MMLU each at the protocol evomerge
  uses (we trust their existing eval). The numbers must be
  measured **in the same wrapper** that runs G1, on the same
  hardware, on the same date.
- **Pass condition**: each Δ ≥ −1.0pp from the same base without
  LoRA. (Allowed positive drift but not required.)
- **Fail surface**: any single benchmark Δ < −1.0pp → escalate to
  user per §0.7 (acceptable trade-off requires explicit
  authorisation; we do not pre-approve).

### G3 — Data isolation

- **Set difference**: every V1 ruler item id (the 30 fixed ones)
  MUST NOT appear in any `provenance.v1_item_id` field of train
  or val splits. Eval split (the new 200-item benchmark) must also
  not overlap with V1 ruler.
- **N-gram check**: 8-gram surface-form check between V1 ruler
  task strings and any train/val task strings. Per evomerge
  CLAUDE.md §0.8.
- **Pass condition**: zero overlap on both axes. Single overlap
  hit → reject the data, regenerate.

## 9. Deliverable — what we expect back

```
evomerge-mt-sft-v1/
├── adapter_config.json               # PEFT standard
├── adapter_model.bin                 # ~12 MB at r=16
├── tokenizer/                        # required for Ollama Modelfile
├── Modelfile                         # FROM <base> + ADAPTER ./
├── training_log.json                 # loss curves, step counts, GPU type
├── eval_results.json                 # G1 + G2 numbers, all three gates
├── locality_check.json               # GSM8K / IFEval / MMLU deltas with CIs
├── data_manifest.json                # n-gram + id overlap audit
└── EVALUATION_REPORT.md              # narrative
```

**The one ascii-art table** we want in `EVALUATION_REPORT.md`:

```
                 base      base+LoRA  Δ      McNemar p
arm-f acc:       NN.N%     NN.N%      +NNpp  4.8e-7
GSM8K:           NN.N%     NN.N%      ±NNpp
IFEval:          NN.N%     NN.N%      ±NNpp
MMLU:            NN.N%     NN.N%      ±NNpp
n-gram overlap:  0  ✓
id overlap:      0  ✓
```

## 10. Risks I'm flagging now (not after the fact)

1. **Multi-turn is a novel training domain for evomerge.** All
   their SFT to date is single-turn (GSM8K, MMLU, IFEval). The
   chat-template path with `tool_calls` may need a small patch in
   `p17_b1_sft.py` (~5–10 LOC) to pass `tools` arg through to
   `apply_chat_template`. Budget for that.

2. **Locality regression is the most likely fail mode.** 2k items
   of out-of-domain SFT data on a 1.5B will pull GSM8K down. The
   −1.0pp band is tight. If it fails, the trade-off discussion
   (G2 fail → §0.7) is unavoidable; do not silently re-tune to
   evade.

3. **Quantization may not generalise the LoRA gain.** §0.6 Stage
   3 mandate is real — fp16 LoRA may show +30pp arm-f, q4_k_m may
   show +5pp. We need both numbers in the deliverable. If the
   quant gap is >40% of the fp16 gain, this work is not
   shippable to the customer.

4. **The ≥56% threshold may be unreachable from a 1.5B base.**
   xLAM-2 1B precedent is ~35%; we want 56%. Either (a) start
   from the 1.7B Qwen3 base (Run G's stronger floor at 32.2%),
   or (b) accept that 50% is reachable but not the lower-bound-50%
   target, and re-negotiate the goal with the user before
   spending compute. See §11.

5. **Ollama Modelfile + LoRA adapter pipeline is undocumented at
   evomerge today.** The current `p17_b1_sft.py` saves
   PEFT-format checkpoints; serving them via Ollama requires
   conversion (`llama.cpp` LoRA adapter format). If evomerge's
   serving path doesn't already do this, that's a 1-2 day
   pipeline addition, not a training change.

## 11. If G0 stays unreachable after this work

This spec asks for ≥56% to clear Wilson-lower-50% at n=90. If
after one training cycle the 1.5B base tops out at e.g. 40%, the
verdict converges to "scaffold + SFT on 1.5B both partial; G0
remains FAIL-improvable; the customer story may need to either
(a) target 1.7B Q3 explicitly (Run G floor 32.2% + same SFT lift
≈ 56%+), or (b) accept that the consumer-laptop ≤2B / ≤1.2GB
constraint is incompatible with this benchmark and renegotiate
the floor with the user (e.g. drop to 35%)".

The decision in that branch is the user's, not evomerge's. We
expect a clean number + a recommendation, not a value judgement.

## 12. Provenance

This spec was written by reading evomerge's repository state at
2026-06-13 (CLAUDE.md, scripts/p17_*, src/evomerge/eval/) and
the agentkit-js V2 ablation reports
(docs/reports/multi-turn-scaffold-ablation-2026-06-13/Run F + Run
G). All references to specific evomerge file paths are verified
present at write time; if their Phase 15 restructure moves files,
the script names (not paths) are the stable references — search
for `p17_b1_sft.py` and `finetune_monitor.py` by basename.

The starter dataset in `datasets/multi-turn-sft-starter/` is
generated synthetically from V1 fixture surface forms; no public
benchmark data is included. The 200-item train/val/eval split
that scales this is a **first deliverable from evomerge** — they
own data generation under their G3 protocol; agentkit-js owns the
eval ruler and the spec.
