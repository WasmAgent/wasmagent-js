# Strategy Update — 2026-06-19: Super-Instruction Set (SI-1~9)

## Summary

Delivered a nine-part "super-instruction set" — composable, declarative API shortcuts that
collapse repeated multi-step patterns into single options, analogous to CPU super-instructions.
The theme came from observing that callers (bscode and third-party integrators) were forced to
re-implement the same boilerplate for stop conditions, approval policies, prompt fragments,
and control loops in every project.

## Delivered

### SI-1: parseStopPolicy / parseStopPolicies (`@wasmagent/core`)
- String descriptors `"steps:N"`, `"cost:N"`, `"noProgress"`, `"noProgress:K"` → `StopCondition`
- Moved bscode's `parseStopCondition()` upstream; now available to all consumers

### SI-2: TOOL_SYNTHESIS_FRAGMENT (`@wasmagent/agent-prompts`)
- Synthesis preamble text moved from `ToolCallingAgent.ts` (wrong home) to `fragments.ts`
- Any caller composing a system prompt can include it directly

### SI-3: ApprovalPolicy → `@wasmagent/core`
- `ApprovalPolicy`, `applyApprovalPolicy()`, `PolicyPresets` (permissive/balanced/strict)
- Migrated from bscode; bscode now re-exports from core (zero logic duplication)

### SI-4: stopPolicies option on ToolCallingAgent
- `stopPolicies?: string[]` accepted alongside `stopWhen`, merged in constructor

### SI-5: EnhancementPreset string shortcuts
- `resolveEnhancement("reflect-once" | "self-consistency:3" | ...)` → `EnhancementPolicy`

### SI-6: AgentRunConfig in run_start (Observable)
- Every `run_start` event carries `{ model, tools, maxSteps, stopPolicies, toolSynthesis, signal }`
- All three agent types: `ToolCallingAgent`, `CodeAgent`, `GoalDirectedAgent`
- `AgentRunConfig` exported from `@wasmagent/core`

### SI-7: Constructor-level AbortSignal (Cancellable)
- `signal?: AbortSignal` in constructor options for all three agent types
- Checked at every step boundary; `GoalDirectedAgent` propagates to inner agents
- `CodeAgent.run()` gains `opts` parameter for consistency

### SI-8: AgentSnapshot.agentConfig (Resumable)
- `AgentSnapshot` gains `agentConfig?: AgentRunConfig` field
- `restoreFromSnapshot()` returns `AgentRunConfig | undefined`
- All `checkpointer.save()` calls include `agentConfig`
- `ToolRegistry.names(): string[]` and `size(): number` added

### SI-9: AgentSupervisor — autonomous control loop
- Observe→decide→act cycle wrapping any `ToolCallingAgent`
- Three actions: `continue` (pass through), `abort` (terminate), `restart` (re-invoke factory)
- `agentFactory` pattern ensures each restart has a clean assembler history
- `patchOptions` accumulate across restarts for progressive tightening/relaxation
- Built-in: `retryOnErrorPolicy`, `budgetGuardPolicy`, `noProgressPolicy`, `composePolicies`
- `supervisor_decision` event added to `AgentEvent` union

## Test coverage
- +95 new tests across all nine SIs
- 910 core tests pass, 73 cloudflare-worker, 34 integration, 390 bscode worker

## Architectural insight
This set answers the question "why doesn't the observation feed back into decisions?"
- Before SI-6: run_start had `{ task }` only — black box
- Before SI-7: only `run()` opts had signal — no pre-binding
- Before SI-8: snapshots lost agent config — callers had to remember it externally  
- Before SI-9: no bidirectional feedback channel existed

With SI-1~9 complete, the loop is closed: observe (SI-6) → decide (SI-9 policy) → act (abort/restart) → resume (SI-8). Any long-running, multi-step task can now self-manage without caller involvement beyond supplying the initial policy.
