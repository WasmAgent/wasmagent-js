# Super-Instruction Set (SI-1~9)

Composable, declarative shortcuts that collapse repeated multi-step patterns into single options — the same idea as CPU super-instructions. All are exported from `@wasmagent/core`.

### SI-1: Stop policy descriptors

```ts
import { ToolCallingAgent } from "@wasmagent/core";

// String descriptors instead of factory functions
const agent = new ToolCallingAgent({
  tools, model,
  stopPolicies: ["steps:10", "cost:0.5", "noProgress:3"],
});
```

Accepted formats: `"steps:N"`, `"cost:N"` (USD), `"noProgress"`, `"noProgress:K"`.
Also available as a standalone parser: `parseStopPolicy(desc)`, `parseStopPolicies(descs)`.

### SI-2: Tool synthesis fragment

```ts
import { TOOL_SYNTHESIS_FRAGMENT, composePrompt } from "@wasmagent/agent-prompts";

const prompt = composePrompt({
  persona: "You are a coding assistant.",
  fragments: [REASONING_FIRST, TOOL_SYNTHESIS_FRAGMENT("execute_code")],
});
```

### SI-3: Approval policy (write-gate)

```ts
import { PolicyPresets, applyApprovalPolicy } from "@wasmagent/core";

// Wrap write tools with HITL gate based on preset
const gatedTools = applyApprovalPolicy(PolicyPresets.balanced(), tools);
// balanced: dotfiles/CI configs + delete/rename + large writes require approval
// strict:   everything requires approval
// permissive: nothing requires approval
```

### SI-4: stopPolicies on ToolCallingAgent

See SI-1 above — `stopPolicies` is a constructor option directly on `ToolCallingAgent`.

### SI-5: Enhancement preset shortcuts

```ts
import { resolveEnhancement, ToolCallingAgent } from "@wasmagent/core";

const agent = new ToolCallingAgent({
  tools, model,
  enhancementPolicy: resolveEnhancement("reflect-once"),
  // other presets: "self-consistency:3", "parallel-fork:3", "budget-forcing", "none"
});
```

### SI-6/7/8: Observable · Cancellable · Resumable

Every agent run now emits its full configuration at `run_start`:

```ts
for await (const event of agent.run(task)) {
  if (event.event === "run_start") {
    const { model, tools, maxSteps, signal } = event.data.agentConfig;
    console.log(`Running ${model} with ${tools.length} tools, max ${maxSteps} steps`);
  }
}
```

Pre-bind an `AbortSignal` at construction time (SI-7):

```ts
const ac = new AbortController();
const agent = new ToolCallingAgent({ tools, model, signal: ac.signal });
// later: ac.abort() terminates at the next step boundary
```

Checkpoints now include the agent config so resume doesn't need external storage (SI-8):

```ts
import { restoreFromSnapshot, InMemoryCheckpointer } from "@wasmagent/core";

const snap = await checkpointer.load(traceId);
const config = restoreFromSnapshot(snap, assembler); // returns AgentRunConfig | undefined
// config.model, config.tools, config.maxSteps — rebuild the agent from the snapshot
```

### SI-9: AgentSupervisor — autonomous control loop

The supervisor wraps any agent in an observe→decide→act cycle. After every event, a policy function decides to continue, abort, or restart the agent with updated options:

```ts
import {
  AgentSupervisor,
  budgetGuardPolicy,
  retryOnErrorPolicy,
  composePolicies,
  ToolCallingAgent,
} from "@wasmagent/core";

const supervisor = new AgentSupervisor({
  agentFactory: (patch) => new ToolCallingAgent({ tools, model, maxSteps: 10, ...patch }),
  task: "Analyse this report and write a summary",
  policy: composePolicies([
    budgetGuardPolicy(50_000),  // abort when cumulative tokens exceed 50k
    retryOnErrorPolicy(2),      // restart up to 2 times on error
  ]),
});

for await (const event of supervisor.run()) {
  if (event.event === "supervisor_decision") {
    // action: "abort" | "restart", reason, runCount
    console.log("Supervisor intervened:", event.data);
  }
  // All other events are identical to agent.run()
}
```

Built-in policies: `retryOnErrorPolicy(n)`, `budgetGuardPolicy(maxTokens)`, `noProgressPolicy(k)`, `composePolicies([...])`. Custom policies implement a single `evaluate(event, history, runCount)` method.
