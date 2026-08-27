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
| 2026-06-12 | (initial publish)    | release  | First npm publish of `@wasmagent/core@0.2.0` and the 31-package family. CHANGELOG `[Unreleased]` baseline starts here. |
| 2026-06-13 | (no tag — mid-cycle) | status   | Mid-cycle status row. `[Unreleased]` has accumulated: Direction 1 codemode shim + mcp-server stdio entry + `glama.json` registration + cloudflare/agents issue [#1753](https://github.com/cloudflare/agents/issues/1753) (collaborators_only repo, filed as issue with ready-to-cherry-pick fork branch); Direction 2 swe-bench-lite **all five harness slots filled** (`loadTasks` / `dispatchCodemode` / `dispatchDirect` / `runTests` containerised judge under `examples/benchmarks/judge/` / `reportPareto`) + `swe-bench-judge.yml` CI workflow; Direction 4 bscode lazy-loaded `FrameworkApiMap` + `/recipes` is its own minimal chunk; Direction 6 bscode `/recipes` live route. Next bi-weekly tag window: ≤ 2026-06-26. Status rows do NOT count as releases — they exist so a reader can tell `[Unreleased]` has work landing without us silently waiting on the deadline. |
| 2026-06-24 | (no tag — mid-cycle) | status   | Zero-tech-debt pass: brand clean across all 3 repos, `objective_status` schema field, 33-package tier metadata, `docs/api/stability-policy.md` + `stable-exports.md`, `e2e-data-loop.mjs`, `check-release-cadence.mjs`, bscode security defaults (fail-fast auth, `include_unknown` filter, PII redaction), eval-trust report generator. Next bi-weekly tag window: ≤ 2026-07-08. |

### Retroactive backfill (added 2026-08-27)

The ledger above stopped being maintained on 2026-06-24 even though
releases kept shipping — exactly the "stale ledger" failure this file
exists to prevent. Rows below were reconstructed from `git tag`
creator dates and the per-package CHANGELOGs. From this point forward
rows land with the release commit again.

| Date (ISO) | Tag | Type | Notes |
|---|---|---|---|
| 2026-06-23 | v1.0.0 | release | First stable `@wasmagent/core@1.0.0`. Public API lock declared (`docs/api/stability-policy.md`). |
| 2026-06-24 | v1.0.3 | release | Patch follow-up to the 1.0 line. |
| 2026-06-26 | v1.2.0 | release | Bi-weekly window (≤ 2026-06-26) hit on time. |
| 2026-06-27 → 2026-07-22 | v1.3.0 … v1.21.0 | release | Cadence held through the 1.x line (weekly-to-fortnightly minors). Full list: `git tag -l 'v1.*'`; per-version notes in each package CHANGELOG. |
| 2026-07-23 | v2.0.0 | **release (major)** | Breaking API/schema cut requiring a major. **Retrospective:** the release automation landed v2.0.0 and v3.0.0 within the same run — tags at 17:21 and 17:24 HKT — with no deprecation cycle between them, violating the "major = deliberate breaking change with deprecation cycle" contract in `docs/strategy/api-stability.md`. Trigger: two breaking-change-detection bumps queued in one CI pipeline run with no rapid-major guard. Guard added: `scripts/check-rapid-major-bump.mjs` fails a release that would tag a new major within 24h of the previous one (wired into `.github/workflows/release.yml`). |
| 2026-07-23 | v3.0.0 | **release (major)** | Second major 3 minutes after v2.0.0 — see the v2.0.0 retrospective. Enterprise-facing consequence: changelog reviewers see two majors in one day; treat v2.0.0 as an intermediate alignment step, not a supported line. |
| 2026-07-29 → 2026-07-31 | v3.1.0 … v3.3.1 | release | Steady minors/patches across core, aep, compliance, mcp-gateway and the linked `@wasmagent/*` group (`.changeset/config.json`). |
| 2026-08-01 | v3.0.2 | release | Patch-line maintenance. |
| 2026-06-24 → 2026-08-27 | (ledger gap) | **stall** | The ledger itself went unmaintained for two months while releases continued — the inverse of the stall this file watches for. Backfilled 2026-08-27; monitoring restored. |

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
