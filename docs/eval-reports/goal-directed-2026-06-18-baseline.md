# GoalDirectedAgent baseline — 2026-06-18

> **TL;DR.** First end-to-end run of `wasmagent goal` against a real model.
> A 718-byte prompt produced a 10,602-byte Chinese OAuth 2.0 introduction
> that passed all 7 self-synthesised criteria on iteration 1.
> **Outcome: `verified`. Iterations: 1/5. Tokens: 8,357 in / 8,530 out.**

This is the differentiation evidence for the
[Eighth axis](../guides/goal-directed.md): the agent synthesises its own
success criteria, executes, verifies, and iterates only as needed — closing
the loop **without** the user supplying graders by hand.

## Setup

| | |
|---|---|
| Date | 2026-06-18 |
| CLI | `wasmagent goal` (built from `packages/cli/dist/index.js`) |
| Model | `claude-sonnet-4-6` (executor + LLM judge + criteria synthesiser) |
| Tools | `read_file`, `write_file` (auto-wired by CLI) |
| Workspace | `.tmp/baseline-2026-06-18/` (gitignored) |
| Flags | `--max-iterations 5 --judge-samples 3 --stream` |
| Backend | Local Anthropic-compat proxy (via `ANTHROPIC_BASE_URL` env var) |

## Task

```
Write a 1500-word introduction to OAuth 2.0 in oauth.md (in Chinese),
covering: what OAuth is, the four roles, the four grant types, security
considerations, and a worked example. Use clear section headings.
```

## Synthesised criteria (Phase 1)

The agent proposed **7 criteria** mixing deterministic and LLM-judge:

| ID | Method | Argument | Type |
|---|---|---|---|
| `file_exists` | `file_exists` | — | det |
| `word_count` | `word_count_min` | 1400 | det |
| `file_size` | `file_size_min` | 2800 (UTF-8 floor) | det |
| `headings_structure` | `headings_count_min` | 5 | det |
| `four_roles` | `llm_judge` | "...all four OAuth 2.0 roles..." | LLM |
| `four_grant_types` | `llm_judge` | "...all four grant types..." | LLM |
| `security_and_example` | `llm_judge` | "...security + worked example..." | LLM |

**Notes on quality.**

- The agent recognised that "1500 words" in Chinese needs a UTF-8-safe
  byte floor (2800 B), not just a word count. A naive scaffold wouldn't.
- Three deterministic guards run free of LLM cost; three LLM-judge
  criteria check semantic content the deterministic verifier can't.
- Every criterion has a `path` field — the verifier knows exactly which
  workspace file to inspect.

## Execution (Phase 2)

```
[scout]    tools=2, workspace=0 entries
[criteria] 7 criterion(a) synthesised
[goal #1]  starting iteration 1/5
  step 1: write_file(oauth.md, …)        — 1427 → 5404 tok
  step 2: model_done                      — 6930 → 3126 tok
  final_answer: "The file `oauth.md` has been created…"
[verify]   all 7 criteria passed
[outcome]  verified ✓
```

The model wrote `oauth.md` in a single tool call (5,404 output tokens),
then issued a brief summary in step 2. No retry was needed.

## Verdict (Phase 3)

```json
{
  "outcome": "verified",
  "iterationCount": 1,
  "totalInputTokens": 8357,
  "totalOutputTokens": 8530
}
```

## Produced artefact (`oauth.md`)

| Metric | Value | Threshold | Pass? |
|---|---|---|---|
| File size (bytes) | 10,602 | 2,800 | ✓ (3.8×) |
| Lines | 179 | — | — |
| H1/H2/H3 headings | 15 | 5 | ✓ (3×) |
| OAuth role mentions | 27 | all 4 | ✓ |
| Grant types covered | 4 | all 4 | ✓ (LLM-judged) |
| Security + example | both | both | ✓ (LLM-judged) |

**First 250 chars (verbatim):**

```markdown
# OAuth 2.0 入门指南

## 1. 什么是 OAuth 2.0？

OAuth 2.0（开放授权 2.0）是一种行业标准的授权框架，由互联网工程任务组（IETF）在 RFC 6749 中正式定义。它允许第三方应用在**不暴露用户密码**的前提下，代表用户访问受保护的资源…
```

The doc opens with a definition, cites RFC 6749, contrasts pre-OAuth
password sharing, and lays out the four-role structure with a section per
role. This is the kind of artefact that a single-shot `CodeAgent.run()`
would also produce, so it's not the *content* that matters here — it's
that the agent **decided what "good" looked like before starting** and
**checked itself at the end**.

## What this run does and does not prove

**Proves:**

1. The CLI wires criteria-synthesis → execution → verification end-to-end,
   passes its events through, and reports a structured outcome.
2. The agent generates non-trivial criteria specific to the task (Chinese
   UTF-8 byte floor, role-name list, grant-type checklist) — not a
   one-size-fits-all template.
3. Mixed deterministic + LLM-judge verification works: the deterministic
   floor catches sub-spec output cheaply; the LLM-judge catches semantic
   omissions deterministic checks can't.

**Does not prove (open follow-ups):**

1. **Retry behaviour under failure.** This task verified on iteration 1.
   We need a "stress" task where iteration 1 fails (e.g. truncated output)
   and iteration 2 must read the verifier hint and recover. Tracked as a
   follow-up next to this report.
2. **Adversarial verifier robustness.** `judge-samples=3` was used but
   not contested — the LLM-judge said PASS three times. A run where
   the executor and judge are different model tiers (haiku judge over
   sonnet output, or vice versa) would test independence.
3. **Cost scaling.** 8.5k output tokens on one task; we don't yet have a
   cost curve vs. task complexity.

## Reproducing this run

```bash
# Set ANTHROPIC_API_KEY. If pointing at a local proxy, also set
# ANTHROPIC_BASE_URL — the CLI auto-honors it as of 2026-06-18.
export ANTHROPIC_API_KEY=...

mkdir -p .tmp/baseline
node packages/cli/dist/index.js goal \
  "Write a 1500-word introduction to OAuth 2.0 in oauth.md (in Chinese), \
   covering: what OAuth is, the four roles, the four grant types, security \
   considerations, and a worked example. Use clear section headings." \
  --workspace .tmp/baseline \
  --max-iterations 5 \
  --judge-samples 3 \
  --stream > .tmp/baseline/transcript.ndjson
```

Transcript (16 events) and produced `oauth.md` are in
`.tmp/baseline-2026-06-18/` on the dev machine but **not committed** —
they hold execution timestamps and a long sample doc. The numerics cited
above (token counts, byte sizes, criterion list) are sufficient for the
narrative.
