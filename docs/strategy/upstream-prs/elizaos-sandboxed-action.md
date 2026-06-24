# Upstream: elizaOS/eliza — WasmAgent rollout data export plugin

**Target repo:** [`elizaOS/eliza`](https://github.com/elizaOS/eliza)
**Issue:** [elizaOS/eliza#9087](https://github.com/elizaOS/eliza/issues/9087)
**PR (original):** [elizaOS/eliza#9235](https://github.com/elizaOS/eliza/pull/9235)
**PR (registry):** [elizaOS/eliza#9244](https://github.com/elizaOS/eliza/pull/9244)
**Status:** 🟢 ACTIVE — registry PR under review; CapabilityManifest landed in core

---

## Timeline

### 2026-06-24: Initial PR #9235 — permission governance rejected

> "You can register a third party plugin, or make a direct contribution to the project,
> but we are wary of third party dependencies directly in the application.
> I don't think that people will correctly configure this and we all just bypass all
> permissions on our agents already anyways."
> — lalalune

Dropped Option A (capability governance wrapper). Pivoted to rollout data export
as a standalone community plugin.

### 2026-06-24: `@wasmagent/eliza-rollout-plugin` implemented and published

- `packages/eliza-rollout-plugin/` implemented in this repo
- Published to npm as `@wasmagent/eliza-rollout-plugin@1.0.4`
- Registry PR [#9244](https://github.com/elizaOS/eliza/pull/9244) submitted to
  `packages/registry/entries/third-party/`
- Replied on #9235 with pivot explanation and registry PR link

### 2026-06-24: lalalune merges CapabilityManifest into `@elizaos/core` (commit 6c6011746b)

> "Implemented the CapabilityManifest core in-monorepo — landed the core as a small,
> opt-in, additive utility in @elizaos/core security, so it composes with the existing
> Bun Worker sandbox + RemotePluginPermissions rather than introducing a nested sandbox."
> — lalalune

`@elizaos/core/security` now exports:
- `withCapabilityGovernance(action, manifest)` — wraps an action under a deadline + host/path policy
- `applyCapabilityManifest(task, manifest)` — wall-clock deadline enforcer
- `isHostAllowed` / `assertHostAllowed` — subdomain-aware host predicate
- `isPathAllowed` / `assertPathAllowed` — traversal-rejecting path predicate
- `frozenEnv(manifest)` — frozen per-call env snapshot

**Significance:** The original #9235 PR was the external catalyst for this feature landing
in core. WasmAgent did not write it, but the conversation created the demand signal.

### 2026-06-24: Open questions answered on #9235

lalalune asked two questions; replied:

1. **Wall-clock deadline vs worker-backed CPU accounting** — wall-clock is the right
   primitive; worker-backed CPU is follow-up material only if concrete demand emerges.
2. **Data loop on top of governance?** — keep them separate. Governance in core,
   data export in the community plugin. The two compose cleanly.

---

## Current architecture (as shipped)

| Capability | Location |
|---|---|
| Per-call deadline + host/path governance | `@elizaos/core/security` (merged by lalalune) |
| Training data loop (rollout capture → rank → JSONL) | `@wasmagent/eliza-rollout-plugin` (community plugin) |

### Composition pattern (documented in plugin README)

```ts
import { withCapabilityGovernance } from "@elizaos/core";
import { createRolloutPlugin } from "@wasmagent/eliza-rollout-plugin";

const governed = withCapabilityGovernance(myAction, {
  allowedHosts: ["api.example.com"],
  cpuMs: 10_000,
});

export default {
  actions: [governed],
  plugins: [createRolloutPlugin()],
};
```

---

## Open items

- [ ] #9244 registry PR: awaiting lalalune / elizaOS maintainer review
- [ ] Monitor `@elizaos/core` 1.7.x → 2.x API changes that could affect the plugin's
      structural types (no hard dep on `@elizaos/core`, but `ElizaRuntime` / `ElizaAction`
      shapes may drift)
