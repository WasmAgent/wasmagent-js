---
"@wasmagent/core": minor
"@wasmagent/cloudflare-worker": minor
---

**HealthMetrics singleton for runtime operational health (#388)**

- New `@wasmagent/core` `HealthMetrics` (`packages/core/src/observability/HealthMetrics.ts`): process-wide singleton recording the five core reliability signals — tool latency, failures, timeouts, policy denials, and token resource consumption — with a read-only `getSnapshot()`.
- `ToolCallingAgent` instruments its execution path (guardrail tripwires, error paths, parallel tool latency/timeout/failure classification, `model_done` token usage) into the singleton.
- Cloudflare Worker `/health` now returns `{ status, version, metrics: <snapshot> }` so the existing health endpoint exposes operational state.
- Worker tests: `/health` asserts the metrics block; the `@wasmagent/core` mock gains a matching `HealthMetrics` stub.
