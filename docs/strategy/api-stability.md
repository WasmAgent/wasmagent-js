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

## Stable surface (SemVer-protected) — `@wasmagent/core`

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
- **Re-exports from sub-paths** (`@wasmagent/core/executor`,
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
| `@wasmagent/evals-runner`             | Statistics axis (warmup, energy, McNemar) is still being shaped by P16 work; types may grow fields        |
| `@wasmagent/mastra-sandbox`           | Tracks Mastra's sandbox provider contract; pinned to upstream signature                                   |
| `@wasmagent/aisdk` `codeModeTool()`   | Awaiting AI SDK v6.x type stabilization                                                                   |
| `@wasmagent/devtools` HTTP endpoints  | URL surface still flexing as we add framework-agnostic OTel ingest (D5)                                   |
| `core/src/scheduler/SimpleIR`           | DAG IR shape may consolidate with `ActionIR`                                                              |
| `core/src/skills/SkillRegistry`         | Skill manifest schema is converging with [agents.md] cross-tool conventions                                |
| `core/src/checkpoint/redis`             | Awaiting at least one production deployment to confirm the resume protocol                                |

If you depend on an experimental surface and want it stabilized,
open an issue with your use case — that is exactly the signal we
need to graduate something.

## Non-`@wasmagent/core` packages

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

## 1.0 freeze schedule

> Added 2026-06-12 in response to the strategy memo's L3 ("make
> trust legible") and the 2026-06 optimization brief's Direction 3
> — "give core API a 1.0 freeze date." Without a concrete date,
> "stable surface" reads as aspirational; with one, it becomes a
> commitment users and co-maintainer candidates can plan around.

The plan is to ship `@wasmagent/core` **v1.0.0 on 2026-12-15**.
That is six months after the first npm publish (2026-06-12) and is
a hard date, not "when ready" — slipping it requires a public
RFC under `docs/rfcs/` explaining what changed.

What 1.0 means *in practice*:

- Every name on the **Stable surface** above is locked. From v1.0.0
  onward a breaking change to those names requires a major version
  bump (v2.0.0) and a deprecation cycle of ≥1 minor release.
- Every surface in the **Experimental** table either graduates
  (the `@experimental` JSDoc tag is removed and the surface joins
  the stable face) or is explicitly carried into 1.0 *still* marked
  experimental — with the reason updated to reflect the new
  blocker. Experimental surfaces in 1.0 keep the right to change
  in a 1.x minor release; the type-system tag remains the
  load-bearing signal.
- Per-package SemVer remains independent. Adapters (`aisdk`,
  `mastra-sandbox`, `claude-agent-sdk`, `openai-agents`) hit 1.0
  *only* when their upstream's contract has stabilized — until
  then they stay 0.x even if `core` is 1.0.

What 1.0 does **not** mean:

- It is not a feature freeze. Roadmap items continue to land in
  1.x minor releases.
- It is not a quality claim beyond "we won't break the names." Bug
  fixes, documentation, and performance work continue under the
  same cadence.
- It is not a promise that *every* package reaches 1.0 by the same
  date. Only `@wasmagent/core` is on the calendar above.

### Pre-freeze checklist (gates the 2026-12-15 tag)

Each item below is closed in a tracked issue under the
`milestone:1.0` label before the v1.0.0 release tag is pushed. If
any item is open on 2026-12-01 the maintainer pages a public
status update, not a quiet slip.

- [ ] **Co-maintainer landed.** Per `GOVERNANCE.md`, ≥2 npm
      publishers and ≥2 GitHub maintainers with merge rights.
- [ ] **Cadence proven.** Six consecutive bi-weekly releases shipped
      without a stall (i.e. no `governance:release-stall` issue
      opened against the run-up).
- [ ] **Sandbox-escape drill record.** At least one entry in
      [`docs/strategy/security-drill-log.md`](security-drill-log.md)
      showing the SLA rehearsal was run end-to-end (even on a
      synthetic finding).
- [ ] **Public benchmark number.** At least one number in the
      README's "Verified status" table comes from a public dataset
      with a reproducible CLI (LongMemEval-500 or
      SWE-bench-lite-class — whichever lands first; see ROADMAP).
- [ ] **Experimental table reviewed.** Each surface in the table
      above has a recorded decision — graduate, defer with a new
      reason, or remove.
- [ ] **CHANGELOG migration note.** A "Migrating to 1.0" section
      exists in `CHANGELOG.md` listing every removed deprecation
      and every renamed export.

If a checklist item slips and the freeze is rescheduled, the new
date and the reason go *here*, in this file, on the same git
commit that updates the deadline.

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
