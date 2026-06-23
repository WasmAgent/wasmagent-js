# Goal-Directed Agents: Why You Should Stop Writing One-Shot Loops

> **TL;DR.** A normal "tool-calling agent" makes one pass and prints whatever
> the model decided to call done. A **goal-directed agent** synthesizes its own
> success criteria, verifies them deterministically (with an adversarial LLM
> judge as a last resort), and *loops with feedback* until it passes — or
> tells you exactly what's missing. wasmagent ships this as a first-class
> primitive: `GoalDirectedAgent`. Most teams using wasmagent don't reach for
> it, and most teams using *any* agent framework don't have it. That gap is
> where shipping quality comes from.

---

## The problem with the default loop

Almost every agent tutorial — including the ones in `getting-started.md` —
shows a `ToolCallingAgent` running once and emitting a `final_answer`:

```ts
const agent = new ToolCallingAgent({ model, tools });
for await (const ev of agent.run("write a doc explaining quasi-dry batteries")) {
  // …yield events to UI
}
```

This is a **one-shot loop**. The model decides when it's done. If the model
thinks an outline counts as a finished document, you get an outline. If it
forgets a section, you get five sections instead of six. If the user wanted
1500 words and the model wrote 700, you get 700. There is no separate party
in the run that asks "did this actually meet the user's goal?".

Three pathologies follow:

1. **Outline-itis.** Long-form generation tasks ("write an introduction
   to X") collapse to a table of contents because the model treats listing
   the structure as having delivered it. We saw this in production — a
   user asked for a technical introduction; the agent saved a 718-byte
   outline and called it done.
2. **Reward-shaped output.** When the model is graded only by "did it stop
   without throwing", it stops as soon as it can. Brevity is locally
   optimal even when wrong globally.
3. **No deterministic feedback.** When the answer is wrong, there is no
   structured error you can hand back. The user has to read the output,
   notice it's bad, type a complaint, and pray the next try is better.

This is where goal-directed loops earn their keep.

## What goal-directed adds

`GoalDirectedAgent` (added in v0.x — see
[`packages/core/src/agents/GoalDirectedAgent.ts`](../../packages/core/src/agents/GoalDirectedAgent.ts))
runs five phases per task:

```
                user task: "write an intro to half-wet batteries"
                  │
                  ▼
   ┌───────── Phase 0: Scout ────────────────────────────────────┐
   │ list tools, snapshot workspace files, surface memory hints   │
   └─────────────────────────────────────────────────────────────┘
                  │
                  ▼
   ┌───────── Phase 1: Synthesize criteria (1 LLM call) ─────────┐
   │ prompt: "what would make this task demonstrably done?"       │
   │ → returns Criterion[] (file_size_min: 1500, headings≥4,      │
   │     llm_judge: covers principle/types/applications/future…)  │
   └─────────────────────────────────────────────────────────────┘
                  │
                  ▼
   ┌───────── Phase 2-4: GoalAgent loop ─────────────────────────┐
   │  while !verified and iter < maxIter:                          │
   │    ToolCallingAgent.run(task + criteria)         ← Phase 2-3 │
   │    VerificationPipeline.run(criteria)            ← Phase 4   │
   │    if pass → break; else feed hint into next iter            │
   └─────────────────────────────────────────────────────────────┘
                  │
                  ▼
              goal_directed_done event
              { outcome, iterationCount, criteria, verdicts… }
```

The structural shifts that matter:

| | One-shot ToolCallingAgent | GoalDirectedAgent |
| --- | --- | --- |
| Who decides "done"? | The executing model. | A separate pipeline of deterministic + adversarial-LLM checks. |
| What happens when output is bad? | User notices, retries. | Loop catches it, feeds the failure as a hint, retries automatically. |
| Length / structure compliance | "Just trust me." | Mechanical (`file_size_min`, `headings_count_min`, `word_count_min`). |
| Subjective quality (covers topic, idiomatic style) | Not checked. | `llm_judge` with default-fail + k-of-N voting. |
| Visibility | Final answer only. | UI sees criteria, every verdict, every retry hint. |

The asymmetry is sharp: one-shot agents produce things that *look like*
work; goal-directed agents produce things that *survive a check*.

## When this is the right tool

Pick `GoalDirectedAgent` when **at least one** of these is true:

- The output has a verifiable property the user cares about (length,
  structure, "tests pass", "build succeeds", "a specific function
  exists in the file").
- The task is long enough that a wrong-direction first attempt would
  waste the user's turn.
- Multiple iterations are an acceptable cost (the loop is opt-in
  exactly because it is more expensive — see "cost shape" below).
- You want the UI to *show* what success looks like (criteria are
  visible to the user; this is a product differentiation surface).

Pick `ToolCallingAgent` (the default) when:

- The task is short, and a wrong answer is cheaply re-runnable.
- The user wants to chat, not deliver an artifact.
- Token cost dominates (e.g. embedded in a high-volume back-end).

`GoalAgent` (without the `Directed`) is the right pick when **you, the
operator**, can write the verify function — running tests, checking a
specific predicate, polling an external system. `GoalDirectedAgent`
is the layer above that, where the **agent itself** synthesizes the
verifier from a freeform task description.

## What this is NOT

It is not a replacement for any of these — they remain wasmagent's
other axes of differentiation:

- **Multi-provider model adapters** (`@wasmagent/model-anthropic`,
  `model-doubao`, `model-qwen`, `model-zhipu`, `model-deepseek`,
  `model-moonshot`, `model-minimax`, `model-local`) — bring your own
  vendor.
- **Multi-runtime kernels** (`kernel-pyodide`, `kernel-quickjs`,
  `kernel-wasmtime`, `kernel-remote`) — execute generated code in the
  shape that fits your security and compute envelope.
- **Memory layers** (`MemoryBlockSet`, `Checkpointer`, structured
  observational memory) — wasmagent doesn't make you pick.
- **Workflow engine** (`LocalWorkflowEngine`,
  `CloudflareWorkflowEngine`) — durable, resumable, checkpointable
  multi-step flows.
- **Code-mode** (single `execute_code` tool that compresses N MCP
  tools into one) — radically lower per-call token cost on tool
  registries that grow.
- **AG-UI** (typed inbound channel from the UI to the agent) —
  frontend-tools and JSON-Patch state deltas without the brittleness
  of free-form messages.
- **Devtools / OTel exporter** (`packages/devtools`,
  `packages/otel-exporter`) — every agent step is an inspectable span.

`GoalDirectedAgent` is the **eighth axis**: the loop primitive. It
composes with all of the above (e.g. an LLMJudge that uses a different
provider; a verifier that runs WASM tests; a workflow that triggers a
goal-directed sub-step). It does not replace anything; it raises the
ceiling on what those parts can deliver.

## Adversarial defaults — read these

LLM-as-judge is the reward-hacking risk point. The literature on this
([Loop Engineering](./loop-engineering.md), the RLVR / Rebound papers
cited there) is clear: when an LLM grades its own work the loop
collapses into theatre.

`LLMJudgeVerifier` is engineered to push back, not concede:

1. **Default fail.** The judge prompt instructs the model to return
   `pass: false` whenever it is uncertain or the artifact is missing
   important content. The schema also defaults to `false` if the
   reply is unparseable.
2. **K-of-N voting.** Default `samples=3`, default policy
   `requirePassMajority=false` — meaning **all three** must pass.
   Any single dissent fails the criterion. (You can soften this to
   majority, but the default exists for a reason.)
3. **Independent judge model.** `judgeModel` is a separate field on
   `GoalDirectedAgentOptions`. Use a stronger or differently-aligned
   model than the executor when it matters; reduces self-graded
   inflation.
4. **Determinism preference.** `Phase 1` is prompted to reach for
   `llm_judge` only when no mechanical check fits. Length, structure,
   presence of identifiers, regex patterns — all of those go to
   `DeterministicVerifier` first.
5. **The criteria are visible.** UI consumers receive the full
   `criteria_proposed` event before execution starts. If the
   synthesized criteria are weak, the user sees that *before* the
   loop wastes iterations.

These defaults are deliberately strict. Loosening them is allowed —
the constructor takes overrides — but anyone doing so should read the
loop-engineering guide first.

## Cost shape

Per task, `GoalDirectedAgent` adds:

- **One synthesis call** (Phase 1, ~1-2k tokens; cheap model recommended).
- **K judge calls per `llm_judge` criterion per iteration**. With
  defaults (`samples=3`), that is `3 × #llm_judge_criteria × iterations`.
- **Iterations themselves** — same cost as raw `ToolCallingAgent`
  but multiplied by `iterationCount` (capped by `maxIterations`).

In practice, simple tasks (synthesis returns 1-2 deterministic
criteria, executor satisfies them on the first try) cost ~+10-15%
over a single ToolCallingAgent run. Hard tasks (3-5 iterations,
several `llm_judge` criteria) can run 3-5x. The `tokenBudget` option
caps total spend; see also `synthModel` (cheaper model for synthesis)
and `judgeModel` (independent grader).

The **opt-in** posture is intentional. wasmagent's product partners
expose this as a UI toggle ("Loop until verified") rather than a
default — because for casual chat the extra cost is wasted.

## Minimum viable usage

```ts
import { GoalDirectedAgent } from "@wasmagent/core";

const agent = new GoalDirectedAgent({
  model: executor,            // sonnet 4.6
  synthModel: synth,          // haiku for cheap criteria
  judgeModel: judge,          // independent grader
  tools: yourTools,
  workspaceReader: yourWs,    // read-only window for verifiers
  scout: {
    tools: yourTools.map((t) => ({ name: t.name, description: t.description })),
    workspaceEntries: await yourWs.listTopLevel(),
  },
  maxIterations: 3,
  judgeSamples: 3,
});

for await (const ev of agent.run(userTask)) {
  // ev.event ∈ {scout_done, criteria_proposed, model_done,
  //             tool_call, tool_result, goal_iteration_start,
  //             goal_directed_done, …}
  switch (ev.event) {
    case "criteria_proposed":
      ui.showCriteria(ev.data.criteria);     // <- product differentiator
      break;
    case "goal_directed_done":
      ui.showFinalReport(ev.data);
      break;
  }
}
```

The UI surface — showing the synthesized criteria *before* the user
even sees the answer — is the point. It is the visible difference
between a chat that hopes and a chat that delivers.

### Frozen criteria for CI: `wasmagent goal --from-criteria`

For deterministic CI gates and A/B comparisons, you usually don't want
the synth model to invent a fresh grader on every run. Pin the criteria
once and feed them in:

```bash
# Phase 1 still runs the first time — capture the synthesized criteria.
wasmagent goal "Write the OAuth intro" --workspace ./tmp \
  --stream | tee transcript.ndjson

# Extract them into a frozen file your CI commits.
jq -c 'select(.event=="criteria_proposed") | .data.criteria' \
  transcript.ndjson | head -1 > criteria.json

# Subsequent runs skip Phase 1 — same grader every time.
wasmagent goal "Write the OAuth intro" --workspace ./tmp \
  --from-criteria criteria.json
```

Programmatic equivalent — pass `criteria` directly to
`GoalDirectedAgent`:

```ts
const agent = new GoalDirectedAgent({
  model,
  tools,
  workspaceReader: ws,
  criteria: frozenCriteriaList,  // skip synth, use this list verbatim
});
```

When `criteria` is supplied, the synth model is never called and the
`criteria_proposed` event still fires (with the supplied list) so
observers see the same shape regardless. Empty arrays still trigger
the single-shot fallback path — same handling as a synth that returned
zero criteria.

## Auto-routing in product UIs (the bscode pattern)

A user-facing chat product should NOT make people pick "Goal mode vs
Tool mode". The whole point of goal-directed is that the *agent*
decides. So the recommended product wiring is:

1. Keep your existing **task classifier** (or build one — a one-shot
   `claude-haiku` call into a structured-output endpoint is enough).
2. Add a `loop: "single" | "verify"` axis to the classifier's reply
   alongside whatever `mode` axis you already use. The dispatch rule:

   ```ts
   const agentMode =
     classify.loop === "verify" && classify.mode !== "framework"
       ? "goalDirected"
       : classify.mode;
   ```

   `framework` mode is exempt because a real-app build already has its
   own plan→build→preview loop (the WebContainer side-channel) —
   stacking another verify-loop on top is redundant.

3. **Don't ship a manual toggle.** A `🎯 Goal` button in the UI is a
   complexity tax: most users won't know when to flick it, and the
   classifier can decide better than they can. bscode shipped one
   for half a day before the user asked "why am I picking this?" —
   they were right.

4. **Do** show the classifier's choice on the turn badge ("Tool + DAG
   · 🎯") so users can see what the agent is about to do. Hidden
   routing is one bad eval away from "sometimes the chat behaves
   differently and I can't tell why" — visible routing is honest.

The classifier prompt that anchors the `loop` axis is product-specific
(bscode's lives in `apps/worker/src/app.ts`'s `/classify` route). The
shape it produces — `{mode, framework, loop}` — is what your dispatcher
maps. Keep wasmagent's `GoalDirectedAgent` agnostic of how you decided
to invoke it.

## See also

- [`GoalAgent`](../../packages/core/src/agents/GoalAgent.ts) — the
  smaller primitive, when you write `verify` yourself.
- [Loop Engineering guide](./loop-engineering.md) — why
  LLM-as-judge needs adversarial defaults; verify-loop literature.
- [Evals cookbook](./evals-cookbook.md) — how to use the
  evals-runner to put a goal-directed loop on a regression panel.
- [Workflows guide](./workflows.md) — when you need durable, resumable
  multi-step flows the loop is part of.
