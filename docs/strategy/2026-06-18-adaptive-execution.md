# 2026-06-18 adaptive-execution — the ninth axis (planned)

> **Audience:** anyone who read the [06-18 goal-directed update](2026-06-18-goal-directed-shipped.md) and asked "what's the next axis after this?"
>
> **TL;DR.** A user manual-test on 2026-06-18 surfaced the gap. The eighth axis (goal-directed) closed the *did-it-deliver?* loop. The ninth axis closes the *can-it-recover?* loop: when a tool fails, the framework helps the agent find an alternative; when no alternative exists, the framework helps it **synthesise** one; when the goal itself turns out unreachable, the framework helps it **negotiate** an adapted goal with the caller. Inspired by Claude Code's observed behaviour. Not yet implemented — this doc anchors the design and ships ahead of code per [CONTRIBUTING.md S5](../../CONTRIBUTING.md#differentiation-gets-documented-in-the-same-pr-s5).

---

## 0. Why this is the ninth axis, not a bug fix

The user feedback verbatim:

> "成熟的 agent 如 claude code，在一个工具失败后，会寻找替代，甚至自己搜索工具甚至造一个工具来用。就像人类，原先使用工具，后来会制造工具了。表明更智能了。当然，不仅是工具。如果用户的目标无法实现，根据实际情况，也可以修改替代 goal。"

Three claims in one sentence, and they live at three different abstraction layers. Treating them as one fix would either over-engineer the simple case (tool fallback) or under-engineer the deep case (goal adaptation). The fall-out from doing it as one ad-hoc patch:

- A single "retry with a different tool" hook would not cover synthesis (the agent inventing a tool that doesn't exist in the registry).
- A "regenerate the plan when stuck" branch would not cover *renegotiating with the user* — silently changing the goal is the wrong default for a framework that prides itself on `criteria_proposed` transparency.
- The 8th axis (goal-directed) already does *intermediate* adaptation (the verifier hint feeds the next iteration's prompt). What's missing is *meta-adaptation* — when the loop itself signals "the criteria are unattainable, let's renegotiate."

So: ninth axis. Three layers, one strategic frame.

---

## 1. The three layers

### L1 — Tool fallback

**Trigger.** A tool returns `tool_result.error` or throws.

**Today.** The error string is round-tripped to the model verbatim. The model decides: retry same tool with new args / pick another tool from the registry / give up. The framework is uninvolved.

**Proposed.** The framework knows about *alternative relationships* between tools. When `write_file` fails (e.g. permission denied), the framework can offer `append_file` and `patch_file` as candidates *in the next prompt*, framed as "the model called X, X failed with reason R, here are tools the registry says are alternatives — pick or invent." The model still decides; the framework just removes the "did it occur to you to check" failure mode.

**Why this beats letting the model do it alone.** Small models (1.7 B class — see the [evomerge G0 work](../reports/) trail) often *don't* spot alternatives in the registry on their own; their "search the tool list" capacity collapses under pressure. Surfacing the candidate set in-prompt is a structural lift, like grammar-pinning was a structural lift on tool calling itself ([06-17 arm-f vs bare ablation](2026-06-17-update.md#2-the-internal-experimental-campaign-06-17-same-day)).

**Boundary.** Fallback is not retry. Same tool with same args is the model's job. Same tool with new args is the model's job. The framework's job is *cross-tool routing only* and only when the registry annotated the relationship.

### L2 — Tool synthesis

**Trigger.** No registered tool matches what the agent wants to do, or all candidate tools have failed.

**Today.** Code-mode (`execute_code` compressing N MCP tools into one) exists but the agent has no first-class reason to reach for it on a tool-shape mismatch. It's framed as a token-saving optimisation, not as a synthesis primitive.

**Proposed.** Reframe `execute_code` (and the kernel matrix beneath it — VmKernel / WASM / RemoteSandbox) as the **fallback substrate when tool synthesis is needed**. The synthesis prompt: "the registry doesn't have a tool that does `<X>`; you can use `execute_code` with the kernel's stdlib to write one inline." The agent gets to *make* a tool, run it once, and discard it.

**Why this is meaningful.** Three competitor frameworks ship code-mode (Cloudflare, OpenAI Agents SDK, Mastra — see the [06-17 update](2026-06-17-update.md#1-the-5-industry-shifts-06-12--06-17)). None of them frame it as the synthesis substrate when registered tools fail. They frame it as a token-cost optimisation. We can pitch this as **the second meaning** of code-mode, fitting our existing kernel matrix without new packages.

**Boundary.** The synthesised "tool" is single-use, scoped to the kernel's `CapabilityManifest`, and not registered into the persistent ToolRegistry. The next turn's prompt sees the synthesis as an `execute_code` call with its result, not as a new tool. Adding it to the registry would be a separate decision (and is a known footgun for security review).

### L3 — Goal adaptation

**Trigger.** A goal-directed run has consumed a meaningful fraction of `maxIterations` or `tokenBudget`, *and* the verifier failures cluster around criteria that look **structurally unattainable** (verifier consistently fails the same criterion across iterations with hint variants the model has tried).

**Today.** The `goal_directed_done` event has three outcomes: `verified` / `single-shot` / `failed (budget|exhausted)`. There's no fourth outcome representing "I think we should change what we're trying to do." If the run hits exhausted, the user sees only "couldn't deliver" with the last-iteration verdicts.

**Proposed.** A new outcome `negotiation_proposed` and a new event `goal_adaptation_proposed`. The agent (via the synth model, the same one that wrote the original criteria) proposes a *modified criteria set* with reasoning: "criterion X looks unattainable because `<evidence from the verifier hints>`; here's a relaxed variant that I believe is reachable, plus the original kept under `dropped: [...]` for the caller's audit." The caller — be it the CLI user, a CI script, or a UI — accepts/rejects/edits, and the loop resumes with the new criteria set (or hard-fails if the caller declines).

**Why this is structurally different from L1+L2.** L1 and L2 keep the goal fixed and adapt the *means*. L3 acknowledges the goal itself was wrong. That's a fundamentally different value claim:

- L1+L2 = "the agent is more resourceful"
- L3 = "the agent knows when not to be heroic"

These compose: a run can do L1 fallbacks throughout its iterations, hit a dead end, *then* propose L3 negotiation. The frame they share: the framework helps the agent stay productive on the user's actual problem instead of grinding on the model's first interpretation of it.

**Boundary.** L3 is opt-in. The default `` `agentkit goal "<task>"` `` run still hard-fails on exhausted iteration cap — this preserves CI determinism. `agentkit goal --allow-negotiate` (or its programmatic equivalent in `GoalDirectedAgentOptions`) flips the bit. This matters for [06-17 referee positioning](2026-06-17-update.md#2-the-internal-experimental-campaign-06-17-same-day): a referee that lets the contestant change the rules mid-match is no longer a referee.

---

## 2. How this composes with the eighth axis

The 8th axis is about **transparency of the loop**. The `criteria_proposed` event tells the user what the agent is trying. The 9th axis is about **transparency of recovery**. Three new event-stream artefacts make recovery visible:

| New event | Layer | What observers see |
|---|---|---|
| `tool_fallback_offered` | L1 | "tool A failed, registry offers B, C — model picked B" |
| `tool_synthesised` | L2 | "no registered tool for `\<intent\>`; `execute_code` synthesised an inline one and called it" |
| `goal_adaptation_proposed` | L3 | "after N iterations criterion X looks unattainable; proposed relaxed variant `Y`. Awaiting caller decision." |

A goalDirected run on a task that hit recovery looks like:

```
[scout]    tools=4, workspace=2 entries
[criteria] 5 criterion(a) synthesised
[goal #1]  → write_file(blog.md) → ERR: read-only fs
           ← tool_fallback_offered: registry suggests append_file, patch_file
[goal #1]  → patch_file(...) → OK
           ← verify: 4/5 pass; criterion `cited_sources` → fail (hint: "no 2026 sources cited")
[goal #2]  ← retry with hint, same failure pattern
[goal #3]  ← retry, same failure pattern
[outcome]  goal_adaptation_proposed
            keep:    [file_exists, word_count, headings, no_pii]
            relax:   cited_sources → "any sources cited" (was: "≥2 sources from 2026")
            reason:  "search tools didn't surface 2026-dated sources for this niche;
                      the model can cite older ones reliably"
[caller]   accept → resume with new criteria
[goal #4]  ← write_file → 5/5 pass
[outcome]  verified
```

That's the user-visible difference in one trace. Compare to today's `failed (exhausted)` with a wall of failed verdicts and no path forward.

---

## 3. Where the field is on 2026-06-18

| Framework | L1 fallback | L2 synthesis | L3 goal adapt |
|---|:-:|:-:|:-:|
| Vercel AI SDK 6 | ✗ | ✗ | ✗ |
| OpenAI Agents SDK 2026-04 | ✗ | partial (sandbox) | ✗ |
| LangGraph.js | user-coded | user-coded | user-coded |
| Mastra | ✗ | partial (workspace providers) | ✗ |
| MS Agent Framework | policy-only | ✗ | ✗ |
| Claude Code (Anthropic CLI) | yes (proprietary) | yes (CLI exec) | yes (asks user mid-task) | 
| smolagents-js | ✗ | partial (CodeAct) | ✗ |
| **agentkit-js (planned)** | **annotation-driven** | **kernel-substrate** | **opt-in negotiation event** |

The *partial* entries are honest: OpenAI Agents SDK ships SandboxAgent (so synthesis-via-sandbox is possible if the user wires it; it's not a first-class concept). Mastra ships Workspace providers (same shape).

The asymmetry that justifies the axis: **only Claude Code has all three, and only proprietarily.** Open-source frameworks treat all three as "user-extends-the-framework," which means each user reinvents them and none of them compose with each other or with observability/governance layers above. Shipping these as first-class primitives with stable event types and a `Verifier` / `Tool` annotation surface lets user code on top of *all three at once*.

---

## 4. What's not in scope (intentionally)

- **Persistent learning across runs.** L2 synthesis produces single-use code, not a tool that survives the run. Adding "promote synthesised tool to ToolRegistry" is a separate axis (call it #10 if we get there), with security implications that need their own RFC.
- **Cross-agent skill transfer.** "Agent A figured out how to do X, agent B should benefit" is a memory question, not a recovery question. Lives under the existing 4th axis (memory layers).
- **Plan revision** as a continuous activity. The 9th axis is event-driven (a tool fails / a verifier fails N times). It's not "the agent re-plans every step." The latter is graph-level orchestration territory (LangGraph's strength) and overlaps with L3 only when explicitly hooked.
- **Tool authoring UI in bscode.** L2 synthesis produces ephemeral code in the worker. A "save this synthesis as a permanent tool" UX is a bscode product question, not framework.

---

## 5. Implementation phases (rough)

| Phase | Scope | Estimated effort | Gating |
|-------|-------|------------------|--------|
| 0 | This doc + RFC + 9-axis README row | 1 day (today) | — |
| 1 | L1 — `Tool.alternatives?: string[]` field + ToolRegistry resolver + `tool_fallback_offered` event in CodeAgent | ~2 days | RFC accepted |
| 2 | L2 — code-mode synthesis prompt + `tool_synthesised` event + guide chapter | ~2 days | Phase 1 shipped, kernel matrix unchanged |
| 3 | L3 — `Outcome.negotiation_proposed` + `goal_adaptation_proposed` event + `--allow-negotiate` CLI flag + bscode UI accept/reject modal | ~3 days | Phase 1+2 shipped, eval suite extended |
| 4 | Adversarial evals — paired-stat comparison of "with vs without recovery" on a benchmark of intentionally-fragile tools | ~2 days | All three layers shipped |

A new differentiator without a paired-stat ablation is just marketing. Phase 4 closes that.

---

## 6. Open questions for the RFC

These survive into [`docs/rfcs/adaptive-execution.md`](../rfcs/adaptive-execution.md):

1. **Annotation source** — does `Tool.alternatives` live on the tool, or on a separate `ToolRegistry.fallbackEdges` graph the user owns? (Decentralised vs centralised.)
2. **Synthesis budget** — does L2 count against `maxStepsPerIteration` or have its own cap? Both have failure modes.
3. **L3 caller protocol** — synchronous (block on UI accept) vs asynchronous (emit event, run continues with timeout-default of "decline")?
4. **Backwards compatibility** — existing `GoalDirectedAgentOptions.maxIterations` users must not see new behaviour by default. The flag default is `allowNegotiate: false`.

---

## 7. Why this is worth doing now

Three reasons:

- **The 8th axis is fresh.** The framing for "what differentiates agentkit-js" is already in the reader's mind from yesterday's update. The 9th axis lands while the comparison frame is still warm.
- **It's defensive moat work.** Every framework that ships sandboxes / kernels eventually grows toward L1/L2 because users hit the failure modes. Being first to *ship the framing* is cheaper than racing competitors who arrive at the same conclusion six months later.
- **It's the natural follow-up to the 06-17 governance pitch.** The story so far: "we enforce *what* an agent can do (CapabilityManifest) and verify *whether* it delivered (goal-directed)." The 9th axis adds: "and we keep it productive when the first plan doesn't survive contact with reality." That's a completed pitch.

---

*See [`docs/rfcs/adaptive-execution.md`](../rfcs/adaptive-execution.md) for the design proposal. See the [06-18 goal-directed update](2026-06-18-goal-directed-shipped.md) for the axis this builds on. See [`CONTRIBUTING.md` S5](../../CONTRIBUTING.md#differentiation-gets-documented-in-the-same-pr-s5) for the rule that put this doc on disk before any code.*
