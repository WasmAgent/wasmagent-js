# @wasmagent/cloudflare-worker

## 0.3.0

### Minor Changes

- c947fbf: **HealthMetrics singleton for runtime operational health (#388)**

  - New `@wasmagent/core` `HealthMetrics` (`packages/core/src/observability/HealthMetrics.ts`): process-wide singleton recording the five core reliability signals — tool latency, failures, timeouts, policy denials, and token resource consumption — with a read-only `getSnapshot()`.
  - `ToolCallingAgent` instruments its execution path (guardrail tripwires, error paths, parallel tool latency/timeout/failure classification, `model_done` token usage) into the singleton.
  - Cloudflare Worker `/health` now returns `{ status, version, metrics: <snapshot> }` so the existing health endpoint exposes operational state.
  - Worker tests: `/health` asserts the metrics block; the `@wasmagent/core` mock gains a matching `HealthMetrics` stub.

### Patch Changes

- Updated dependencies [c947fbf]
  - @wasmagent/core@3.5.0
  - @wasmagent/ag-ui@1.0.14
  - @wasmagent/kernel-quickjs@1.2.11
  - @wasmagent/models@2.0.7

## 0.2.1

### Patch Changes

- Updated dependencies [2f93dfc]
  - @wasmagent/core@3.4.0
  - @wasmagent/ag-ui@1.0.13
  - @wasmagent/kernel-quickjs@1.2.10
  - @wasmagent/models@2.0.6

## 0.2.0

### Minor Changes

- f7a6cc9: Publish `@wasmagent/cloudflare-worker` to npm (issue #363). Removes `"private": true`, sets `publishConfig.access: "public"`, declares the compiled `dist/index.js` / `dist/index.d.ts` entry points, ships `dist` + `LICENSE` + `README.md` in the tarball, and includes the package in the changesets Release workflow (removed from `.changeset/config.json#ignore`) so CI publishes it on tagged releases.
