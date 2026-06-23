# RFC: adaptive execution (L1 fallback / L2 synthesis / L3 goal adaptation)

> **Status:** all 4 phases shipped 2026-06-18 · paired-stat ablation green (L1/L2/L3 all p = 1.86e-9 on mock-LLM, n=30 per arm) · bscode UI integration in flight
> **Author:** maintainer + Claude (paired)
> **Tracks:** [`docs/strategy/2026-06-18-adaptive-execution.md`](../strategy/2026-06-18-adaptive-execution.md) (the *why*)
> **All phases of 4 complete on wasmagent-js** — see [`docs/eval-reports/adaptive-execution-2026-06-18-baseline.md`](../eval-reports/adaptive-execution-2026-06-18-baseline.md) for the ablation evidence.

This RFC proposes the **API shape** for the ninth differentiation axis. It does not propose implementation details beyond what's needed to commit to the public surface. Phases 2–4 will each get their own follow-up RFC for the per-layer mechanics.

CONTRIBUTING.md mandates an RFC for any public-API change. The 9th axis touches three public surfaces (`Tool`, `Kernel`, `GoalDirectedAgentOptions`), so this RFC lands first; implementation PRs reference back to it.

---

## Problem

Today, when a tool call fails, the framework does nothing structural to help the agent recover. The error string round-trips into the next prompt, and the model decides what to do next from scratch. Three failure modes follow:

1. The model retries the same tool with the same args and loops.
2. The model gives up too early — it doesn't notice a sibling tool in the registry that would have worked.
3. The goal itself is unattainable but the loop has no way to say so. After `maxIterations` it ends with `failed (exhausted)` and a wall of red verdicts.

For frameworks competing on "did it deliver" (8th axis), this is the natural follow-up gap.

The user's concrete trigger on 2026-06-18: *"成熟的 agent 如 claude code，在一个工具失败后，会寻找替代，甚至自己搜索工具甚至造一个工具来用。如果用户的目标无法实现，根据实际情况，也可以修改替代 goal."* That's three abstraction layers in one sentence; this RFC respects the layering.

---

## Proposed shape

Three additions, in three layers. They compose; each is opt-in.

### L1 — `Tool.alternatives`

```ts
// packages/core/src/tools/types.ts (proposed addition)
export interface ToolDefinition</* existing generics */> {
  name: string;
  description: string;
  inputSchema: ZodSchema;
  // ... existing fields ...

  /**
   * Names of registered tools the framework should suggest as
   * alternatives when this tool's `forward()` throws or returns an
   * `error` field. The framework does NOT auto-call them — it surfaces
   * them in the next prompt so the model can pick. This avoids
   * silently substituting a tool whose semantics differ.
   *
   * Tools listed here MUST be present in the same ToolRegistry; the
   * resolver fails closed (no suggestion) on dangling names rather
   * than throwing.
   */
  alternatives?: string[];
}
```

Resolver lives in `ToolRegistry`:

```ts
toolRegistry.fallbacksFor(toolName: string): ToolDefinition[];
```

A new event in the standard agent event stream:

```ts
{ event: "tool_fallback_offered",
  data: { failedTool: string, error: string, candidates: string[] } }
```

The agent loop (`CodeAgent` / `ToolCallingAgent` / `GoalDirectedAgent`) inserts a system-style message into the next turn:

> Tool `X` failed with: `<error>`. The registry suggests these alternatives: `Y` (description), `Z` (description). You may pick one, retry `X` with different args, or use `execute_code` to synthesise a one-off tool.

### L2 — `kernel-substrate` synthesis

No new package, no new tool. We **reframe `execute_code`** as the synthesis substrate when no registered tool fits. This is a prompt-engineering change in the agent's system prompt, plus a new event type:

```ts
{ event: "tool_synthesised",
  data: { intent: string, kernelType: string, success: boolean } }
```

`intent` is the model-stated reason it reached for `execute_code` instead of a registered tool. `kernelType` is which kernel (VmKernel / QuickJSKernel / PyodideKernel / WasmtimeKernel / RemoteSandboxKernel) ran it. The event is emitted by the agent loop, not the tool — the tool has no idea it's being used as synthesis vs as a registered code-mode call.

The synthesis prompt is opt-in via:

```ts
new GoalDirectedAgent({
  /* ... */
  enableToolSynthesis: true,  // default false for backwards-compat
});
```

### L3 — Goal adaptation

A new outcome and a new event:

```ts
// packages/core/src/agents/GoalDirectedAgent.ts (proposed change)
export type GoalDirectedOutcome =
  | "verified"
  | "single-shot"
  | "failed-budget"
  | "failed-exhausted"
  | "negotiation-proposed";  // NEW

{ event: "goal_adaptation_proposed",
  data: {
    keepCriteria: Criterion[],     // unchanged
    relaxCriteria: Array<{          // proposed modifications
      original: Criterion,
      proposed: Criterion,
      reasoning: string,
    }>,
    droppedCriteria: Criterion[],   // proposed removals (with reasoning)
    iterationCount: number,
  } }
```

Caller protocol — synchronous-by-default with a timeout escape:

```ts
new GoalDirectedAgent({
  /* ... */
  allowNegotiate: true,  // default false
  onAdaptationProposed?: async (proposal) => {
    // Caller returns:
    //   { decision: "accept" }
    //   { decision: "reject" }
    //   { decision: "edit", criteria: Criterion[] }  // counter-proposal
    return { decision: "accept" };
  },
  adaptationTimeoutMs?: 30_000,  // default: hard-fail with negotiation-proposed
});
```

CLI flag mirror:

```bash
wasmagent goal "<task>" --allow-negotiate
```

In `--allow-negotiate` CLI mode without `--from-criteria`, the agent prints the proposal and reads user decision from stdin. With `--from-criteria` set, `--allow-negotiate` is a noop (CI mode prefers determinism — accept this asymmetry).

---

## Why-not (alternatives considered and rejected)

### "Just let the model handle it"

This is what the framework does today. The strategy doc §1 covers why it's insufficient, especially for sub-3B models that don't reliably search the registry on their own. The grammar-pinning ablation on 06-17 is the closest analogue: small models can't *use* a capability that's only implicit in the prompt, but they *can* use one that the framework hands them on a plate. L1 hands them the candidate set on a plate.

### "Use MCP for everything; let the protocol handle fallback"

MCP doesn't ship a fallback / synthesis / adaptation primitive. The protocol is *list of tools*, not *graph of relationships between tools*. We could lobby for one, but it'd take quarters; the user-visible gap is today.

### "Register synthesised tools persistently"

Out of scope (strategy doc §4). Persistence introduces security review burden the single-use case doesn't have. If the value materialises, it gets its own RFC.

### "L3 should be opt-out, not opt-in"

Strategy doc §1 covers why opt-in: a referee that lets contestants change the rules mid-match isn't a referee. CI users in particular benefit from deterministic exhaust. Opt-in via `allowNegotiate` keeps both audiences happy.

### "L1+L2+L3 should ship together"

Sequencing them lets each build adoption without the others. L1 is useful even on its own (legacy `ToolCallingAgent` users get fallback). L2 alone gives goal-directed users a richer prompt. L3 alone is the most valuable but the most expensive — phasing means we get user feedback on each layer before locking the API for the next.

---

## Migration / backwards compatibility

- `Tool.alternatives` is optional. Existing tools work unchanged.
- `enableToolSynthesis` defaults to `false`. Existing `GoalDirectedAgent` constructions are byte-identical.
- `allowNegotiate` defaults to `false`. The new `negotiation-proposed` outcome only ever appears when this is set.
- `GoalDirectedOutcome` gains a string variant. Any consumer using exhaustive switch on it will get a TypeScript error and need to handle the new case — that's the point. Update the `wasmagent goal` CLI's outcome printer in the same PR that flips the type.

---

## Adversarial evals (Phase 4)

A new suite under `packages/evals-runner/src/suites/adaptive-execution.ts`:

- **L1 ablation:** a tool registry with `write_file` deliberately broken (returns 503), `append_file` works. Measure: does the agent recover with vs without `Tool.alternatives` annotation? Paired McNemar across 50 task prompts.
- **L2 ablation:** task that requires an operation not in the registry (e.g. "compute SHA-256 of a file's content"). Measure: does enabling synthesis raise pass-rate? Same paired-stat shape.
- **L3 ablation:** task with deliberately unattainable criterion (e.g. "include a 2026-12-25 source citation" before the date is real). Measure: with `allowNegotiate=true`, does the agent propose a sensible relaxation? Hand-rated with rubric.

Following the [06-17 referee positioning](../strategy/2026-06-17-update.md): the headline isn't "we shipped it"; the headline is "here's the paired-stat number proving it helped."

---

## Open questions

1. **Should L1 alternatives be model-suggested or human-curated?** Today's proposal: human-curated (`Tool.alternatives`). A future extension could allow model-suggested at registration time, but this RFC keeps the trust model simple.
2. **Token cost of L1 prompt insertion.** Every fallback-offer adds ~80–150 tokens. On long failure chains this compounds. The implementation should cap "offered fallbacks per turn" at, say, 3 and dedupe across turns.
3. **L2 synthesis vs registered code-mode call.** Today these are indistinguishable in events (both are `tool_call` for `execute_code`). Phase 2 needs a clean way to discriminate without changing the kernel API. Probably a header in the agent's `execute_code` invocation.
4. **L3 in `wasmagent verify`.** Should the deterministic-only `verify` command grow a `--suggest-relaxation` flag for offline criteria editing? Maybe later; not Phase 3.

---

## Ship checklist

When this RFC is accepted, Phase 0 of strategy doc §5 is complete. Phase 1 (L1) gets its own implementation PR; Phase 2 (L2) and Phase 3 (L3) follow. Each implementation PR amends the README 9-axis row's status from "RFC drafted" → "phase 1 shipped" → "phase 2 shipped" → "fully shipped" so the 9-axis table stays in sync with reality.
