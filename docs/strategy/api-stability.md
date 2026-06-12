# API Stability

> Last refreshed: **2026-06-12**.
> Companion to [`CHANGELOG.md`](../../CHANGELOG.md) and
> [`docs/strategy/2026-06-competitiveness.md`](2026-06-competitiveness.md).

This page tells you, for every exported name, whether you can depend
on it surviving the next minor release. We split the API into two
faces:

- **Stable** — covered by SemVer. Breaking changes only on a major
  version bump; deprecations announced ≥1 minor release in advance
  with a migration path.
- **`@experimental`** — may change in a minor release. Use them, but
  pin exact versions and read the CHANGELOG before upgrading.

The split is in the type system: experimental exports carry a
`/** @experimental */` JSDoc tag in their declaration, and the
TypeDoc-generated docs label them accordingly. Removing the tag is
the act of stabilizing a name.

## Stable surface (SemVer-protected) — `@agentkit-js/core`

The barrel file [`packages/core/src/index.ts`](../../packages/core/src/index.ts)
is the entire stable face. Every name re-exported there is in scope
for SemVer guarantees *unless* it carries the `@experimental` tag.

The shape promise:

- **Public types** — adding optional fields is non-breaking; making
  an optional field required is breaking; renaming or removing a
  field is breaking.
- **Public classes / functions** — adding optional parameters is
  non-breaking; changing the order of required parameters is
  breaking; adding a required method to an interface a user
  implements is breaking.
- **Re-exports from sub-paths** (`@agentkit-js/core/executor`,
  `/tools`, `/models`) — same rules.

If a stable name needs to change shape, the workflow is:

1. Add the new shape next to the old one on a `*-next` name or as
   an additional overload.
2. Mark the old name `@deprecated` with a pointer to the new name
   in JSDoc.
3. Ship for ≥1 minor release with both names live.
4. Remove the deprecated name on the next major.

## Experimental surface

The following packages and exports are explicitly experimental in
0.2.x and may change without a major bump. Reasons are listed so we
remember to graduate them:

| Surface                                 | Why experimental                                                                                          |
|-----------------------------------------|-----------------------------------------------------------------------------------------------------------|
| `@agentkit-js/evals-runner`             | Statistics axis (warmup, energy, McNemar) is still being shaped by P16 work; types may grow fields        |
| `@agentkit-js/mastra-sandbox`           | Tracks Mastra's sandbox provider contract; pinned to upstream signature                                   |
| `@agentkit-js/aisdk` `codeModeTool()`   | Awaiting AI SDK v6.x type stabilization                                                                   |
| `@agentkit-js/devtools` HTTP endpoints  | URL surface still flexing as we add framework-agnostic OTel ingest (D5)                                   |
| `core/src/scheduler/SimpleIR`           | DAG IR shape may consolidate with `ActionIR`                                                              |
| `core/src/skills/SkillRegistry`         | Skill manifest schema is converging with [agents.md] cross-tool conventions                                |
| `core/src/checkpoint/redis`             | Awaiting at least one production deployment to confirm the resume protocol                                |

If you depend on an experimental surface and want it stabilized,
open an issue with your use case — that is exactly the signal we
need to graduate something.

## Non-`@agentkit-js/core` packages

Each kernel package, model preset, tool package, and integration
package independently tracks SemVer. Their public face is the
package's `index.ts` barrel. Internal modules (anything not
re-exported from the barrel) are *not* part of the public face,
even when imported directly.

## "Frozen" promise on packages with no version history yet

The first release of every package is 0.2.0 (so the monorepo could
ship in lock-step). The next release will version per-package via
changesets, and the *cadence* — at least one tagged release every
two weeks while there is unreleased work in `CHANGELOG.md` — is
itself part of what this page promises. A stalled changelog is a
governance bug, not a feature delay; flag it as such.

## How to read a JSDoc tag

```ts
/**
 * Run a multi-model evaluation with paired statistics.
 *
 * @experimental — the option set may grow in 0.3.x.
 */
export async function runEvaluation(/* … */) { /* … */ }
```

In a future release, when the `@experimental` tag is removed and
the function appears in this page's stable surface, you can rely on
SemVer for it. Until then: pin, watch the CHANGELOG, and complain
loudly if we break you.
