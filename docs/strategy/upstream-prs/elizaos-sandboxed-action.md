# Upstream: elizaOS/eliza — WasmAgent capability governance plugin

**Target repo:** [`elizaOS/eliza`](https://github.com/elizaOS/eliza)
**Issue:** [elizaOS/eliza#9087](https://github.com/elizaOS/eliza/issues/9087)
**Status:** 🔴 PIVOTED — original per-call sandbox approach rejected (2026-06-24)

## Feedback received

> "Sandboxing individual calls doesn't work with our model, where the whole agent is in a sandbox."
> — lalalune, 2026-06-24

This is correct. elizaOS wraps the entire agent runtime in a **Bun Worker** with
`RemotePluginPermissions`, providing OS-process-level isolation for the whole agent.
Nesting a WASM kernel inside that is redundant and adds latency without adding security.

## Revised value proposition

The right integration is **not** the sandbox. What WasmAgent adds on top of elizaOS's
existing sandbox:

| WasmAgent capability | elizaOS gap filled |
|---|---|
| `CapabilityManifest` — fine-grained tool permissions (network allowlist, file scope, env vars) | elizaOS `RemotePluginPermissions` is coarse (allow/deny per plugin type, not per tool call) |
| `RolloutForkRunner` + `RolloutRanker` — multi-branch quality selection | elizaOS has no parallel execution or quality ranking built in |
| `TrainingDataExporter` (via evomerge) — DPO/PPO export from agent runs | elizaOS has no rollout data loop |
| `EventLog` + OTel bridge — per-step audit trail | elizaOS has basic logging but no structured trace export |

## Revised contribution shape

### Option A: `@wasmagent/eliza-capability-plugin` (recommended)

Expose `CapabilityManifest` as a per-plugin permission layer on top of elizaOS's
`RemotePluginPermissions`:

```ts
import type { Plugin, Action } from '@elizaos/core';
import { applyApprovalPolicy, PolicyPresets } from '@wasmagent/core';

// Wrap any elizaOS action's tool calls with capability governance
export function withCapabilityGovernance(action: Action, policy = PolicyPresets.balanced()): Action {
  return {
    ...action,
    handler: async (runtime, message, state, options, callback) => {
      const gatedOptions = { ...options, tools: applyApprovalPolicy(policy, options?.tools ?? []) };
      return action.handler(runtime, message, state, gatedOptions, callback);
    },
  };
}

export const wasmAgentCapabilityPlugin: Plugin = {
  name: '@wasmagent/eliza-capability-plugin',
  description: 'Fine-grained tool capability governance for elizaOS agents',
  // Wraps existing actions; does not add a sandbox (elizaOS already has one)
};
```

### Option B: Rollout data export action

Add an `EXPORT_ROLLOUT_DATA` action that captures elizaOS agent runs as
`rollout-wire/v1` records and sends them to evomerge for DPO/PPO training:

```ts
import type { Action } from '@elizaos/core';
import { toJsonl } from '@wasmagent/core/beta';

// Intercept elizaOS run completion → emit rollout-wire/v1 JSONL
const exportRolloutAction: Action = {
  name: 'EXPORT_ROLLOUT_DATA',
  description: 'Export this agent run as a WasmAgent rollout record for training data collection',
  // ...
};
```

## Decision

Pursue **Option A** as a community plugin. Document the architectural boundary
clearly: "WasmAgent does not re-sandbox inside elizaOS; it adds capability governance
and training data export on top of elizaOS's native sandbox."

Update `docs/distribution/upstream-prs.md` when the revised plugin is ready.
