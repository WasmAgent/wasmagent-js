---
"@wasmagent/core": minor
---

feat(core/shared-state): AEP evidence sink — semantic action stream as evidence log (#141)

- Adds `@wasmagent/core/shared-state/aep` subpath exporting `aepEvidenceSink(store, emitter, opts?)`. Subscribing to a `SharedStateStore`, it records each qualifying semantic action as AEP evidence on the caller-supplied `AEPEmitter` via `emitter.addAction(...)` — marking it `state_changing: true` with mapped `side_effect_class` and `recording_mode`. Because the reducer is pure, the same action stream that syncs the UI is a replayable provenance/audit log: the UI sync stream and the evidence stream become one.
- Defaults: `include` records **agent-sourced writes only** (`source === "agent"`) so human edits are not misattributed to the agent; `sideEffectClass` defaults to `"mutate-local"`; `recordingMode` defaults to `"delta"`. `replace()` (no reducer dispatch) is skipped so the stream stays replayable. Returns a detach function.
- Dependency boundary: this dedicated subpath is the only `shared-state` file that references `@wasmagent/aep`, and only via `import type` — the compiled output has zero runtime dependency on the evidence layer, and the base `shared-state` barrel stays dependency-free (enforced by a dependency test).
