# Upstream: elizaOS/eliza — WasmAgent rollout data export plugin

**Target repo:** [`elizaOS/eliza`](https://github.com/elizaOS/eliza)
**Issue:** [elizaOS/eliza#9087](https://github.com/elizaOS/eliza/issues/9087)
**PR:** [elizaOS/eliza#9235](https://github.com/elizaOS/eliza/pull/9235)
**Status:** 🟡 REVISED — permission governance pitch rejected; pivoting to rollout data export as a third-party plugin

## Feedback received (PR #9235)

> "You can register a third party plugin, or make a direct contribution to the project,
> but we are wary of third party dependencies directly in the application.
> I don't think that people will correctly configure this and we all just bypass all
> permissions on our agents already anyways."
> — lalalune, 2026-06-24

Two clear signals:
1. **Third-party plugin format is acceptable** — the elizaOS plugin registry is the right distribution path.
2. **Permission governance is a non-starter** — elizaOS users already bypass all permissions; a finer-grained permission layer solves a problem they don't have.

## Dropped approach

Option A (capability governance) is dead. elizaOS's `RemotePluginPermissions` is coarse
by design and the community has accepted that. Adding a WasmAgent approval layer on top
would be ignored in practice.

## Revised value proposition

The only unique value WasmAgent offers that elizaOS cannot replicate internally is the
**training data loop**: capture multi-branch agent runs, rank them, and export
`rollout-wire/v1` JSONL for DPO/PPO fine-tuning via evomerge.

elizaOS has no equivalent. This is opt-in, zero-configuration-for-the-default-case,
and does not touch permissions at all.

## Contribution shape: `@wasmagent/eliza-rollout-plugin`

A standalone third-party plugin (registered in the elizaOS plugin registry).
Does **not** ship as a dependency inside elizaOS core.

### What it does

- Hooks into `runtime.registerAction` post-execution lifecycle
- Wraps each action run in `RolloutForkRunner` to capture parallel candidates (optional; single-run mode works too)
- Ranks completions with `RolloutRanker` (heuristic scorer by default; LLM judge opt-in)
- Emits `rollout-wire/v1` JSONL to a configurable sink (local file, HTTP endpoint, or evomerge)

### Minimal API surface (no config required)

```ts
import type { Plugin } from '@elizaos/core';
import { createRolloutPlugin } from '@wasmagent/eliza-rollout-plugin';

// Zero-config: writes rollout-wire/v1 JSONL to ./rollouts/ locally
export default {
  plugins: [createRolloutPlugin()],
};

// With evomerge export:
export default {
  plugins: [createRolloutPlugin({ sink: 'https://evomerge.example.com/ingest' })],
};
```

### Why this survives lalalune's objection

- No third-party dep in the core app — it is a community plugin, opt-in
- No permission configuration — bypasses the "people won't configure this correctly" concern
- Solves a real gap: elizaOS agents produce no training data today

## Next steps

1. Implement `packages/eliza-rollout-plugin/` in this repo
2. Publish as `@wasmagent/eliza-rollout-plugin` on npm
3. Submit PR to elizaOS plugin registry (not to eliza core)
4. Reply on PR #9235 acknowledging feedback and linking the community plugin

## Reply to send on PR #9235

> Thanks for the feedback — you're right that the permission governance layer doesn't fit
> the elizaOS model. Pivoting: I've reworked this as a standalone community plugin
> (`@wasmagent/eliza-rollout-plugin`) that adds a training data export loop
> (rollout capture → ranking → DPO/PPO-ready JSONL) without touching permissions or
> requiring any mandatory configuration. I'll submit it to the plugin registry instead.
> Will link here once it's published.
