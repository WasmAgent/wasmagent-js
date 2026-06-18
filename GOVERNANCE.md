# Governance

> Last refreshed: **2026-06-12**.

## Why this file exists

Selection guides for AI-agent frameworks in 2026 weight bus factor,
release cadence, and security-response time as first-class indicators
alongside features. wasmagent currently has a single primary
maintainer and one published version of `@wasmagent/core` on npm.
This file is the public commitment to closing that gap and the
public description of how decisions get made until then.

## Decision rights today

- **Code merges into `main`** — the primary maintainer (the GitHub
  account holding `repo:write` on the `wasmagent` org), with the
  CI gates from [`CONTRIBUTING.md`](CONTRIBUTING.md) honored on every
  PR (lint / typecheck / test / benchmark CI gate).
- **npm publishes** — the same account, via the GitHub Actions
  release workflow when a `v<version>` tag is pushed. Hand-publishes
  from a dev machine are not done.
- **Roadmap edits** — the primary maintainer; community input is
  solicited via issues tagged `roadmap`.
- **Security disclosures** — handled per [`SECURITY.md`](SECURITY.md),
  with the sandbox-escape SLA as the floor.

## What we are explicitly trying to change

- **Co-maintainer.** We are publicly soliciting **one or more
  co-maintainers** with merge + npm-publish authority. Preference
  goes to contributors who arrive through the upstream-adapter work
  (see [`ROADMAP.md`](ROADMAP.md) S1 / "L1" in the strategy memo) —
  someone embedded in the Vercel AI SDK, Mastra, Claude Agent SDK, or
  OpenAI Agents JS communities is exactly the right shape. If that's
  you, open an issue tagged `governance:co-maintainer-interest` with
  a short note about how you'd use the role.
- **Issue-response SLA.** Targeting **first response within 72
  business hours** for any issue, and within **24 hours** for any
  issue tagged `security`. Once we have ≥2 maintainers, this becomes
  enforceable; until then, treat the 72h figure as a goal we are
  measuring ourselves against, not a guarantee.
- **Release cadence.** A tagged release every two weeks while
  [`CHANGELOG.md`](CHANGELOG.md)'s `[Unreleased]` section is
  non-empty. The public ledger lives in
  [`docs/strategy/release-cadence-log.md`](docs/strategy/release-cadence-log.md)
  — every tagged release lands a row, and any *missed* fortnight
  with non-empty `[Unreleased]` lands a stall row with the
  reason. A stalled changelog is a governance bug; flag it as one
  by opening a `governance:release-stall` issue.

- **Sandbox-escape SLA, drilled.** [`SECURITY.md`](SECURITY.md)
  commits to a P0 SLA for kernel escapes. The drill ledger lives
  in
  [`docs/strategy/security-drill-log.md`](docs/strategy/security-drill-log.md)
  — synthetic findings exercise the disclosure path each quarter
  so the SLA is a rehearsed process, not a paper commitment.

- **1.0 freeze date.** Public commitment to ship
  `@wasmagent/core@1.0.0` on **2026-12-15**, with a checklist
  (co-maintainer landed, six bi-weekly releases without stall,
  drill record on file, public benchmark number, experimental
  table reviewed, migration note) gating the tag. See
  [`docs/strategy/api-stability.md`](docs/strategy/api-stability.md#10-freeze-schedule).

## How decisions get made when we have ≥2 maintainers

Once a second maintainer is in place, the rules harden:

- **Code changes** — any maintainer can merge a PR that has
  ≥1 reviewer-approval and clean CI, except for changes inside
  `packages/kernel-*` source, the security-policy face files, or the
  publish workflow, which require a *second* maintainer's review.
- **API freeze breakage** — anything that breaks the SemVer-stable
  surface defined in
  [`docs/strategy/api-stability.md`](docs/strategy/api-stability.md)
  requires unanimous maintainer agreement and a deprecation cycle.
- **New maintainer** — any sitting maintainer can nominate;
  unanimous agreement among current maintainers required to add.
- **Removing a maintainer** — for inactivity (no merges or reviews
  for 90 days) or for code-of-conduct breach. Either path requires
  unanimous agreement of remaining maintainers.

Until the second maintainer is in place, all of the above are
"single-maintainer with the public commitment to invite review."
This document will be updated within 7 days of any maintainer change.

## What we will *not* do as we grow

- **No corporate veto.** No employer of any maintainer gets
  decision-making rights over the project. Sponsorships and grants
  are accepted; control is not transferred.
- **No closed roadmap.** Roadmap edits land as PRs to
  [`ROADMAP.md`](ROADMAP.md), reviewable by the public. Strategy
  memos under `docs/strategy/` are the same.
- **No silent deprecations.** Anything moving from stable →
  deprecated → removed lives in [`CHANGELOG.md`](CHANGELOG.md) for at
  least one minor release before removal, per the API-stability
  document.

## Where to take what

| If you want to…                                  | Use this surface                                                          |
|--------------------------------------------------|---------------------------------------------------------------------------|
| Report a bug or ask a question                   | GitHub Issues                                                             |
| Propose a public-API change                      | RFC under `docs/rfcs/<name>.md`, then issue / PR — see CONTRIBUTING.md     |
| Disclose a security issue                        | `SECURITY.md` — privately first                                           |
| Volunteer as co-maintainer                       | Issue tagged `governance:co-maintainer-interest`                          |
| Flag a stalled release                           | Issue tagged `governance:release-stall`                                   |
| Argue against the strategic direction            | Issue tagged `strategy:dispute` — the [strategy memo](docs/strategy/2026-06-competitiveness.md) lists the explicit falsifiability test |
