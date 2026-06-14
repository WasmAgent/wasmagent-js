# SFT Spec v2 — arm-f shape alignment fix

> **Audience**: evomerge T10 SFT track / future Claude instance under
> evomerge `CLAUDE.md`.
> **Origin**: Run H (2026-06-15, n=90, McNemar paired) showed
> `evomerge-t10-1b7-v3` regressed 21.1pp on arm-f vs the unmodified
> `evo-qwen3-1b7-q3km` base (40.0% → 18.9%, p=1.5e-5).
> **Diagnosis**: SFT training data shape (single-message `tool_calls`
> array, native OpenAI tool-use form) does not match arm-f production
> inference shape (two-pass JSON-schema-grammar).
> **Status**: blocks G0 PASS until resolved.

## What's broken

The starter dataset at
`agentkit-js/datasets/multi-turn-sft-starter/train_seed.jsonl` and the
expanded `evomerge/outputs/t10_sft_data/train_val_eval.jsonl` use
this shape per record:

```jsonc
{
  "messages": [
    { "role": "system", "content": "You operate a sandboxed workspace…" },
    { "role": "user", "content": "Rename notes/draft.md to notes/final.md." },
    {
      "role": "assistant",
      "content": "",
      "tool_calls": [
        { "id": "c1", "type": "function",
          "function": { "name": "move_file",
                        "arguments": "{\"from\":\"notes/draft.md\",\"to\":\"notes/final.md\"}" } }
      ]
    },
    { "role": "tool", "tool_call_id": "c1", "content": "{\"ok\":true}" },
    { "role": "assistant", "content": "DONE", "final_answer": true }
  ]
}
```

This is the **native OpenAI / Anthropic tool-calling shape** — one
assistant message contains both the natural-language thinking AND the
tool_calls array. SFT teaches the model to emit this whole shape in
one decode step.

**arm-f production inference shape** (in
`agentkit-js/packages/evals-runner/src/suites/multi-turn-scaffold-arms.ts:runArmF`):

```
turn N (pass 1):
  messages = [system, user-task, ...history, transient: "Pick the next tool to call"]
  responseFormat = { json_schema: { choice: enum(tool_names + final_answer) } }
  → model emits ONLY {"choice": "move_file"}

turn N (pass 2, only if pass 1 not final_answer):
  messages = [system, user-task, ...history, transient: "Provide arguments for move_file"]
  responseFormat = { json_schema: <move_file's strict args schema> }
  → model emits ONLY {"from": "notes/draft.md", "to": "notes/final.md"}

→ host calls registry.call() and appends a real tool_use + tool_result pair to history
```

The SFT'd model has memorized the `assistant.tool_calls` shape but
arm-f's grammar at pass 1 forbids it (only `{"choice": ...}` is
legal) and pass 2 forbids it again (only the named tool's args
schema is legal). Result: SFT-learned outputs get rejected by the
grammar; the model falls back to whatever its base distribution
samples, which is worse than baseline.

## Required fix — Option A (recommended)

Regenerate the SFT dataset in arm-f's two-pass shape. Each tool call
becomes **two assistant messages**, not one. Per-record schema:

```jsonc
{
  "id": "synth-fs-2step-rename-v2-001",
  "split": "train",
  "category": "fs-2step",
  "messages": [
    { "role": "system", "content": "<ARM_F_SYSTEM_PROMPT verbatim>" },
    { "role": "user", "content": "Rename notes/draft.md to notes/final.md." },

    // arm-f turn 1 pass 1 — tool selection
    { "role": "user", "content": "Pick the next tool to call (or final_answer if the task is complete)." },
    { "role": "assistant", "content": "{\"choice\":\"move_file\"}" },

    // arm-f turn 1 pass 2 — args fill
    { "role": "user", "content": "Provide arguments for move_file as a JSON object matching its input schema." },
    { "role": "assistant", "content": "{\"from\":\"notes/draft.md\",\"to\":\"notes/final.md\"}" },

    // tool result (host-injected after registry.call() succeeds)
    { "role": "tool", "tool_call_id": "c1", "content": "{\"ok\":true}" },

    // arm-f turn 2 pass 1 — final_answer
    { "role": "user", "content": "Pick the next tool to call (or final_answer if the task is now complete)." },
    { "role": "assistant", "content": "{\"choice\":\"final_answer\"}" }
  ],
  "loss_weight_tokens": "default",
  "provenance": { /* same as before */ }
}
```

Key differences:
- **Two assistant turns per tool call** (one for `choice`, one for `args`)
- **No `tool_calls` field on assistant** — the assistant `content` IS
  the JSON object the grammar expects, as a string
- **No `final_answer: true` flag** — final_answer is just another
  `{"choice":"final_answer"}` selection
- **Transient user turns** (Pick / Provide) appear in the training
  history because that's how arm-f sends them at inference time

The `tool_calls` field disappears entirely from training data. The
model learns "user asks → emit choice JSON → asked for args → emit
args JSON → see tool result → emit choice JSON again" — a sequence
arm-f grammar accepts at every step.

## Required fix — Option B (alternative)

Replace arm-f with a different scaffold that accepts native tool_calls.
Specifically: arm-b (grammar=json) with the SFT'd model on arm-a.

We don't recommend this because:
- arm-a 0/90 on Qwen3-1.7B (Run H) — bare path is broken regardless
  of SFT, so there's no path back to G0 ≥50% via arm-a
- arm-b's `format: "json"` constraint forces ALL output to be JSON,
  including the natural-language `assistant.content` text — the SFT
  data has empty content already, so this path might work, but it's
  untested and arm-b in Run F was 0.0% on 1.5B (worse than arm-f)

Option A is the cleaner experiment. Option B is the fallback if data
regeneration is too expensive.

## Implementation steps for Option A

1. **Update the generator** at
   `agentkit-js/datasets/multi-turn-sft-starter/generate.mjs`:
   - Replace the `callTurn(...)` helper to emit two assistant turns
     (choice + args) instead of one with tool_calls
   - Insert `Pick the next tool` user turn before each choice emit
   - Insert `Provide arguments for X` user turn before each args emit
   - Final answer becomes `{"choice":"final_answer"}`, not a plain
     "DONE" string with `final_answer: true` flag

2. **Regenerate train_val_eval.jsonl** at
   `evomerge/scripts/t10_generate_traces.mjs` using the same shape.
   Target ~2000 records (1600 train / 200 val / 200 eval).

3. **Update `p17_b1_sft.py`'s data loader** (if needed):
   - The current loader uses `apply_chat_template(messages)` which
     handles `tool_calls`. With Option A there are no `tool_calls`,
     just plain assistant content — the chat template will handle
     that natively without modification.
   - Remove the workaround that disabled `tools=...` arg (it was
     introduced because tools schema 835 tokens + data exceeded
     max_seq_len → label all -100 → NaN). Without `tool_calls` in
     data, this issue doesn't apply.

4. **Re-run SFT** with the same hyperparameters (`r=16, lora_alpha=32,
   lr=1e-4 fp32, max_seq_len=512, batch=2, save_steps=50`).
   - Expected token length per record: ~250 tokens (vs ~280 in old
     shape) — fits comfortably in 512.
   - Add early-stop on loss <0.1 (CLAUDE.md §11 requirement met by
     `p17_b1_sft.py`).
   - Train ~3 epochs over 1600 records = ~300 steps.

5. **Validate via Run I**: same script as Run H, comparing
   `evomerge-t10-1b7-v4` (Option A SFT'd) against the same baseline
   `evo-qwen3-1b7-q3km`. Expected outcome:
   - arm-a still 0/90 (no change — arm-a doesn't use grammar; this
     SFT shape doesn't help arm-a, only arm-f)
   - arm-f ≥ 50% on `evomerge-t10-1b7-v4` (G0 PASS threshold) or
     at minimum > 40% (baseline)

## Anti-patterns to avoid

- **Do not train with both shapes mixed.** A model that sees both
  native tool_calls and two-pass grammar in training will hedge at
  inference time and emit a malformed hybrid. Pick one shape.
- **Do not modify arm-f's grammar to accept native tool_calls.**
  The whole point of arm-f is the strict per-step grammar; loosening
  it loses the cliff-flattening property.
- **Do not assume Option A SFT will preserve general tool-use
  ability.** A model trained ONLY on arm-f shape will be worse than
  base on arm-a / arm-b / native OpenAI tool-use. That's an
  acceptable trade-off because arm-f IS the production deployment
  shape, but it should be reported as a locality regression on the
  G2 gate.

## Run H artifacts

- `agentkit-js/docs/reports/multi-turn-scaffold-ablation-2026-06-13/run-H-sft-diagnostic/report.md`
- `agentkit-js/docs/reports/multi-turn-scaffold-ablation-2026-06-13/run-H-sft-diagnostic/raw.json`
- This spec: `agentkit-js/docs/strategy/multi-turn-sft-spec-v2-arm-f-shape.md`

## Cross-reference

- Original spec: `agentkit-js/docs/strategy/multi-turn-sft-spec.md`
  (still the authoritative document for everything not contradicted
  here; this is the shape-fix delta)
- evomerge `CLAUDE.md` §T10 (arm-f shape will need to be added; the
  current §T10 still describes the native tool_calls shape, which
  Run H proved inadequate)
- agentkit-js `MEMORY.md` →
  [memory/desktop_agent_feasibility_2026_06_13.md](../../../.claude/projects/-Users-I041705-github-agentkit-js/memory/project_desktop_agent_feasibility_2026_06_13.md)
