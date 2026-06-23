# 2026-06-18 strategy update — goal-directed shipped, eighth axis live

> **Audience:** anyone reading [`ROADMAP.md`](../../ROADMAP.md), [`README.md`](../../README.md), [`docs/compare.md`](../compare.md), or [`docs/guides/goal-directed.md`](../guides/goal-directed.md) who wants to know what shipped on 2026-06-18 and why it matters as an axis the field hasn't yet copied.
>
> **TL;DR.** Three commits the day after the [06-17 strategy update](2026-06-17-update.md) crystallised a new differentiation axis: **the agent synthesises its own success criteria, executes against them, verifies the result, and iterates only as needed.** The CLI now exposes the loop as one command; bscode wires it as the `🎯 Goal` mode toggle; the agent ships with adversarial LLM-judging by default. Plus one CLI fix that fell out of running the baseline. End-to-end evidence: a 718-byte prompt produced a 10.6 KB Chinese OAuth doc that **passed all 7 self-synthesised criteria on iteration 1**.

---

## 0. Why a one-day delta gets its own doc

Most ship-days don't deserve a strategy doc — they're tactical. This one does, because it crosses two thresholds at once:

1. The **eighth differentiation axis** went from "a paragraph in a guide" to "a running CLI loop with a verifier protocol, evals, and a UI surface in a downstream product."
2. We have **end-to-end evidence**, not just a feature flag — `docs/eval-reports/goal-directed-2026-06-18-baseline.md` records the first real run, including the seven criteria the agent synthesised on its own.

If we don't capture this here, the only trace is `git log` — three commits whose messages don't tell the story together. The 06-17 update set the shape; this one logs what landed.

---

## 1. What shipped — three commits, one day

| Commit | Repo | One-line |
|--------|------|----------|
| `5c2ddae` | WasmAgent | `feat(core): GoalDirectedAgent — agent synthesises own success criteria, verifies, loops` |
| `0793062` | bscode | `🎯 Goal` mode toggle — UI wiring of the new agent type, no business logic in WasmAgent |
| `95bec2d` | WasmAgent | `feat(cli): WasmAgent goal/verify + WasmAgent-evals binary; fix model-spec parser` |
| `0017bd0` | WasmAgent | `docs(goal-directed): add Auto-routing pattern — classifier loop axis, no manual toggle` |

**Together they form one product surface**, but they fall into three layers — that layering is the [generic-foundation principle](../../CONTRIBUTING.md) at work:

- `WasmAgent` core gets the **mechanism**: a `GoalDirectedAgent` class, a `Verifier` protocol, a `VerificationPipeline`, deterministic and LLM-judge verifiers, an `LLMJudge` with adversarial sampling default. Zero bscode-isms.
- `WasmAgent` CLI gets the **discovery surface**: `WasmAgent goal "<task>"` runs the loop end-to-end with a local-fs workspace and `read_file`/`write_file` tools auto-wired. `WasmAgent verify --criteria criteria.json` runs the deterministic half without an LLM (CI-friendly).
- `bscode` gets the **UX**: a `🎯 Goal` mode toggle wired to the auto-routing classifier (see `docs/guides/goal-directed.md` "Auto-routing pattern"). The classifier is forbidden from outputting `goalDirected` — manual toggle wins, classifier fills the rest. This codifies last week's lesson on user-choice override.

---

## 2. The eighth product axis, stated plainly

`docs/guides/goal-directed.md` already names seven product axes
(multi-provider model adapters, multi-runtime kernels, memory layers,
workflow engine, code-mode, AG-UI, devtools/OTel). They describe **what
WasmAgent is at rest** — surfaces a user picks from. The eighth axis
is about **how a run unfolds**:

| Axis | One-line value | Status |
|---|---|---|
| **#8 — goal-directed loop** | The agent synthesises its own success criteria, executes against them, and verifies. The user states a goal; the framework supplies the loop. | **Shipped 2026-06-18** ([guide](../guides/goal-directed.md), [baseline](../eval-reports/goal-directed-2026-06-18-baseline.md)) |

This sits orthogonally to the seven existing surfaces. It composes with
all of them (a workflow can trigger a goal-directed sub-step; an LLM
judge can use a different provider than the executor; a verifier can
run inside a WASM kernel) and replaces none.

The repo's *strategy* axes (S1 embedded runtime, S1' governance +
isolation, S2 referee evals, S3 zero-deploy Studio, S4 bscode-as-funnel
— see [`ROADMAP.md`](../../ROADMAP.md) and the
[06-17 update](2026-06-17-update.md)) are a separate framing — they
describe positioning. The eighth product axis fits inside S1' (the
runtime *enforces* what the agent is allowed to do; goal-directed
extends "enforce" with "verify it actually delivered") and sharpens S2
(the loop generates the criteria the referee then checks).

**Why this is novel** (vs. the field, on 2026-06-18):

- **Vercel AI SDK 6 / OpenAI Agents SDK / MS Agent Framework**: ship a single-shot `agent.run()`. The user is the verifier. Retry happens only via outer-loop code the user writes.
- **smolagents / LangGraph**: provide an explicit graph DSL the user authors. The graph is the verification logic. Goal synthesis is the user's job.
- **Anthropic Claude Code (CLI)**: closest in spirit (it does plan and verify in-flight), but proprietary, not framework-portable, and the loop is Anthropic-internal — there's no `Verifier` protocol third parties can extend.

**What's framework-portable here**: the `Verifier` protocol +
`VerificationPipeline` are standard contracts. Anyone shipping a
domain-specific verifier (security scanner, compiler, linter, Lighthouse
audit) plugs into the loop without forking the agent. That's the
*durable* form of the eighth axis — not the specific `LLMJudge`
implementation, but the seam.

---

## 3. Evidence — first end-to-end baseline

Captured in [`docs/eval-reports/goal-directed-2026-06-18-baseline.md`](../eval-reports/goal-directed-2026-06-18-baseline.md). Headline:

| Metric | Value |
|---|---|
| Task | "Write a 1500-word OAuth 2.0 intro in Chinese, oauth.md" |
| Self-synthesised criteria | **7** (4 deterministic, 3 LLM-judge) |
| Iterations to verified | **1 of 5** |
| Output bytes | 10,602 (3.8× the criterion floor) |
| Headings produced | 15 (3× the criterion floor) |
| Token cost | 8,357 in / 8,530 out (executor + judge combined) |
| Outcome | **`verified`** |

**The criteria worth singling out** — they show the agent isn't running a template:

- A `file_size_min: 2800` floor that explicitly accounts for UTF-8 multi-byte Chinese characters (the model derived this; nobody told it).
- An LLM-judge criterion that names the four roles **in Chinese first** (资源所有者/客户端/授权服务器/资源服务器) before falling back to English — matching the prompt language.
- A `headings_count_min: 5` quality gate the model imposed on itself given the prompt said "use clear section headings."

This is what differentiates S8 from "framework that runs a graph the user wrote." The user wrote one sentence; the loop did the rest.

**What's not yet proven** (carried forward as follow-ups):

1. **Retry under failure.** Iteration 1 verified. We need an adversarial task where iteration 2 must read the verifier hint and recover.
2. **Multi-tier verification cost.** The baseline used the same model for executor and judge. The split haiku-judge / sonnet-executor configuration would test independence and lower cost.
3. **Cost curve.** One data point isn't a cost curve. Need 5+ tasks of varying complexity.

---

## 4. The CLI fix that fell out of running the baseline

While preparing the baseline against a local Anthropic-compat proxy (bscode worker on `ANTHROPIC_BASE_URL`), the CLI silently ignored the env var because `AnthropicModel` only forwards `baseURL` if it's passed explicitly. Single point of contact: `buildAnthropicModel(opts, apiKey)` in [`packages/cli/src/index.ts`](../../packages/cli/src/index.ts) now honors:

1. `--base-url <url>` flag (highest precedence)
2. `ANTHROPIC_BASE_URL` env var (fallback)
3. Unset (default — official Anthropic endpoint)

This is the same precedence the official `@anthropic-ai/sdk` uses when constructed directly. Five new tests pin the contract. Filed as G9 in [`docs/strategy/cli-gap-analysis-2026-06-18.md`](cli-gap-analysis-2026-06-18.md).

This fix matters beyond the baseline: anyone running `WasmAgent goal` against a corporate gateway, vLLM, or a sandbox proxy was previously stuck. The 5 lines + helper extraction unblock all of them.

---

## 5. What the field was doing on 2026-06-18

Cross-checked against the 06-17 update's competitive snapshot:

| Framework | Self-synthesises criteria | Built-in verifier protocol | Loop until verified | Notes |
|---|:-:|:-:|:-:|---|
| Vercel AI SDK 6 | ✗ | ✗ | ✗ | `Agent.run()` is single-shot; user wraps the retry loop. |
| OpenAI Agents SDK 2026-04 | ✗ | ✗ | partial | Has tracing + handoffs but no first-class verify-then-retry. |
| LangGraph | ✗ | user-built | user-built | The graph IS the verifier. User authors both. |
| smolagents | ✗ | ✗ | ✗ | One-shot CodeAct loop, exits on `final_answer`. |
| MS Agent Framework | ✗ | policy only | ✗ | Governance toolkit verifies *should*, not *did*. |
| Claude Code (Anthropic CLI) | partial | proprietary | yes | Closest match, but not portable, not extensible. |
| **WasmAgent 2026-06-18** | **✓** | **`Verifier` protocol** | **✓** | Plus deterministic + LLM-judge defaults; CI-friendly via `WasmAgent verify`. |

The asymmetry isn't accidental — the other frameworks are competing on
**graph expressivity**, **tool registry size**, and **observability**.
None of them treat "did the agent meet its own goal?" as a framework
concern. That's the slot the eighth axis fills.

---

## 6. What this changes in the README and ROADMAP

- **README.md** gets an 8-axis comparison table at the top (added in
  this same PR), so visitors see the full product-surface differentiation
  before scrolling into installation.
- **ROADMAP.md** strategy axes (S1, S1', S2, S3, S4) stay as they are —
  the loop primitive doesn't introduce a new strategy axis, it sharpens
  S1' (governance/isolation: the runtime now enforces *and* verifies)
  and S2 (the referee now grades self-synthesised criteria).
- **CONTRIBUTING.md** gets a hard rule (added in this same PR): when
  you ship a new differentiation surface, the **product narrative goes
  in `docs/`** as part of the same PR, not just the code. Without that
  rule, days like 2026-06-18 would leave only `git log` to explain
  themselves — and `git log` doesn't compose.

---

## 7. Open follow-ups (this week)

| # | Follow-up | ETA |
|---|-----------|-----|
| 1 | `WasmAgent goal --from-criteria <path.json>` to skip Phase 1 synthesis (CI-friendly, deterministic input) | this week |
| 2 | A "stress" baseline where iteration 1 fails on purpose, to demonstrate the retry-with-hint loop | this week |
| 3 | Multi-tier judge example (haiku judge + sonnet executor) in `docs/guides/goal-directed.md` | this week |
| 4 | bscode `worker` end-to-end screenshot of the `🎯 Goal` mode (separate, user-driven verification) | when user runs it |

The first one is small (~30 lines) and lands as a separate commit; it's listed in [`docs/strategy/cli-gap-analysis-2026-06-18.md`](cli-gap-analysis-2026-06-18.md) as G3a (CI variant of `WasmAgent goal`).

---

*Anchor for next strategy review: this doc + 06-17 update + cli-gap-analysis form the 2026-06 "what changed and why" trail. The 06-12 doc is the baseline; everything else is delta.*
