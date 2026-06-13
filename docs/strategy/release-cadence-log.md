# Release-Cadence Log

> Created 2026-06-12 in response to the strategy memo's L3 and the
> 2026-06 optimization brief's Direction 3, which calls for the
> bi-weekly release cadence to be *visible* — not just promised.

[`GOVERNANCE.md`](../../GOVERNANCE.md) commits to:

> A tagged release every two weeks while
> [`CHANGELOG.md`](../../CHANGELOG.md)'s `[Unreleased]` section is
> non-empty.

This file is the public ledger that proves we did. Every tagged
release adds one row. A *missed* fortnight while `[Unreleased]`
was non-empty also adds a row, marked as a stall, with a one-line
reason — the honest signal is the absence-of-stalls, not the
presence-of-releases.

## How a row gets added

When a `v<version>` tag is pushed (and the GitHub Actions release
workflow finishes), the release commit also adds the row below
with:

- The ISO date of the tag.
- The version published (e.g. `core@0.3.0`).
- A pointer back to the `CHANGELOG.md` section.
- The number of CHANGELOG entries collapsed into the release
  (rough proxy for "did this fortnight produce work").

If a fortnight ends with `[Unreleased]` non-empty *and no tag
shipped*, the maintainer files a `governance:release-stall` issue
referencing this file, then closes the issue with a row that
records the stall reason (paid leave, blocking upstream change,
etc.). The point is to make the cadence falsifiable.

## Ledger

| Date (ISO) | Tag                  | Type     | Notes                                                                 |
|------------|----------------------|----------|-----------------------------------------------------------------------|
| 2026-06-12 | (initial publish)    | release  | First npm publish of `@agentkit-js/core@0.2.0` and the 31-package family. CHANGELOG `[Unreleased]` baseline starts here. |
| 2026-06-13 | (no tag — mid-cycle) | status   | Mid-cycle status row. `[Unreleased]` has accumulated: Direction 1 codemode shim + mcp-server stdio entry + `glama.json` registration + cloudflare/agents issue [#1753](https://github.com/cloudflare/agents/issues/1753) (collaborators_only repo, filed as issue with ready-to-cherry-pick fork branch); Direction 2 swe-bench-lite **all five harness slots filled** (`loadTasks` / `dispatchCodemode` / `dispatchDirect` / `runTests` containerised judge under `examples/benchmarks/judge/` / `reportPareto`) + `swe-bench-judge.yml` CI workflow; Direction 4 bscode lazy-loaded `FrameworkApiMap` + `/recipes` is its own minimal chunk; Direction 6 bscode `/recipes` live route. Next bi-weekly tag window: ≤ 2026-06-26. Status rows do NOT count as releases — they exist so a reader can tell `[Unreleased]` has work landing without us silently waiting on the deadline. |

Subsequent rows land on the same commit that adds the
`CHANGELOG.md` section heading for the new version. The commit
title format is:

```
chore(release): tag <version> — <one-line summary>
```

## What "non-empty `[Unreleased]`" means

The `[Unreleased]` section is non-empty when its `### Added` /
`### Changed` / `### Fixed` / `### Removed` subsections contain
**at least one bullet that is not** "no changes" / "documentation
only / non-shipping" — the latter are not user-facing and don't
gate a release.

## Why this file exists rather than just `git log`

A reader scanning enterprise selection criteria (release cadence
is on every 2026 framework selection guide) does not parse
`git log` for tag dates. They read the page that *says* "we ship
fortnightly" and then look for evidence. This is the evidence.
