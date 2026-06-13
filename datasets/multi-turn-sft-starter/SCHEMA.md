# Schema — multi-turn SFT starter dataset

> Source of truth: `../../docs/strategy/multi-turn-sft-spec.md` §6.
> This file is a quick reference; if it disagrees with the spec, the
> spec wins.

## Per-record shape

```jsonc
{
  "id": "<unique within file>",
  "split": "train" | "val" | "eval",
  "category": "fs-1step" | "fs-2step" | "fs-3step" | "fs-4step"
            | "cal-1step" | "cal-2step" | "cal-3step" | "cal-4step"
            | "cart-1step" | "cart-2step" | "cart-3step" | "cart-4step"
            | "mixed-3step" | "mixed-4step"
            | "recovery" | "premature-term",
  "messages": [
    { "role": "system", "content": "<ARM_F_SYSTEM_PROMPT verbatim>" },
    { "role": "user", "content": "<task instruction>" },
    // ...assistant + tool turns alternating until final assistant turn...
  ],
  "loss_weight_tokens": "default" | "recovery" | "state_summary",
  "provenance": {
    "source": "agentkit-js/v1-ruler-traces-v1-starter",
    "v1_item_id": "<exact V1 item id>" | "synth-<descriptor>",
    "n_gram_hash": "<sha256 prefix of task string>"
  }
}
```

## Message subtypes

### `assistant` with tool_calls

```json
{
  "role": "assistant",
  "content": "<optional natural-language summary of state before this call>",
  "tool_calls": [
    {
      "id": "c1",
      "type": "function",
      "function": {
        "name": "<tool name>",
        "arguments": "<JSON-stringified args object>"
      }
    }
  ]
}
```

`content` may be empty string. The state-summary loss-weight bucket
applies to records where `content` is non-empty and references the
prior tool result (this is the modeling signal for the
multi-turn-state-collapse failure mode).

### `tool` (response to a tool_call)

```json
{
  "role": "tool",
  "tool_call_id": "c1",
  "content": "<JSON-stringified result OR \"ERROR: <msg>\">",
  "is_error": true | undefined
}
```

`is_error: true` is set when the content begins with `ERROR:`. The
recovery loss-weight bucket applies to records where the next
assistant turn responds to an `is_error: true` tool turn by calling
a discovery tool (list_files / list_events / list_catalog), NOT by
retrying the same failing call.

### `assistant` final answer

```json
{
  "role": "assistant",
  "content": "<final answer text>",
  "final_answer": true
}
```

Always the last message in a record. The `final_answer: true` flag
is informational only — for the SFT loss, both the content and the
flag-bearing turn contribute normally.

## Loss-weight buckets (advisory)

Default training: uniform 1.0× weight on assistant tokens, masked
on system/user/tool tokens.

Optional bucketed weighting (evomerge can ignore):
- `default` — uniform 1.0×.
- `recovery` — 2.0× on assistant tokens that follow a tool turn
  with `is_error: true`. Targets the "recover from path errors"
  failure mode.
- `state_summary` — 1.5× on assistant `content` tokens (the
  natural-language summary) immediately before a `tool_calls`
  emission. Targets the "multi-turn state collapse" failure mode.

These names appear in the `loss_weight_tokens` field; they label
the **dominant** purpose of the record. Records can serve multiple
purposes; we still pick one label.

## Provenance discipline

- `v1_item_id` MUST exactly match a V1 ruler item id when the
  record is teaching a behaviour for that specific V1 item.
- `v1_item_id` MUST start with `synth-` when the record is a
  surface-renamed variant (different filename, event title, SKU)
  that doesn't correspond to any single V1 item. These records
  are **safe to use in train AND eval splits without G3 violation**
  (the V1 ruler will never see these surface forms).
- `n_gram_hash` is a sha256-prefix of the user task string. The
  G3 isolation gate uses this to detect surface-form overlap with
  the V1 ruler tasks.

## Validator

Run `node validate.mjs` (or `node validate.mjs <path>`) before
shipping any version. Exit 0 = clean; non-zero = violations
(printed to stdout).
