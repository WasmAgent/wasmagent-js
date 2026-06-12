# Sandbox-Escape SLA — Drill Log

> Created 2026-06-12 in response to the strategy memo's L3 and the
> 2026-06 optimization brief's Direction 3, which calls for a
> *public* drill record to back the SLA in
> [`SECURITY.md`](../../SECURITY.md).

[`SECURITY.md`](../../SECURITY.md) commits to a P0 sandbox-escape
SLA: 48 h acknowledgement, 7 d mitigation strategy, 30 d patched
release. A commitment without a rehearsal record is a brochure.
This file is the rehearsal record.

## How a drill works

1. A maintainer files a synthetic "P0" finding through the
   `SECURITY.md` private channel (a known-good capability bypass on
   a deliberately mis-configured kernel manifest, not a real vuln).
2. The acknowledgement clock starts at the timestamp on the email /
   advisory, not at the merge of the report PR.
3. The maintainer publishes (in this file, in a new section below):
   - The clock-start timestamp.
   - The clock for each SLA milestone (acknowledged / mitigation /
     patch release).
   - The git SHA of the patch (or "synthetic — no patch shipped"
     for drills that intentionally test process, not code).
   - Lessons learned.

If a real P0 lands, it is logged here too — *after* the public
GitHub Security Advisory and the patched release are out, with
reporter credit per their preference (per `SECURITY.md`).

## Drill schedule

- **Cadence:** at least one drill per quarter while the maintainer
  count is < 3. After ≥3 maintainers, drop to one per half.
- **Owner:** the primary maintainer holds the schedule until a
  co-maintainer is named.
- **Sign-off:** every drill closes with a one-line entry in
  [`CHANGELOG.md`](../../CHANGELOG.md)'s `[Unreleased]` section
  pointing back to this file.

## Drill records

### Drill #0 — 2026-12-15 (planned)

> First scheduled drill. Marked as a 1.0-freeze checklist gate in
> [`api-stability.md`](api-stability.md). Goal is to *prove the
> process*, not to find a real vulnerability.

- **Status:** scheduled.
- **Scope:** synthetic capability-bypass on a `QuickJSKernel`
  manifest deliberately configured with `allowedHosts: []` and a
  manifest mutation hook that "leaks" a host into the runtime.
  Verifies that
  `packages/core/src/executor/capabilities.test.ts` would catch
  the regression and that the disclosure path actually wakes the
  maintainer.
- **Expected outcome:** all three SLA clocks honored on a
  synthetic timeline; no patch shipped (no real vuln).
- **Update on completion:** replace the "Status: scheduled" block
  above with the actual timestamps + a short retro paragraph,
  on the same git commit that updates this file.

## What this log does *not* claim

- It does not claim no real P0 has ever occurred. It claims that
  *if* one occurs, the entry will appear here, and that the
  drill rehearsal exists so the SLA isn't a paper commitment.
- It does not claim a clean drill = a secure kernel. The kernel
  test suite (cross-kernel capability matrix in
  `packages/core/src/executor/capabilities.test.ts` plus the
  per-kernel suites) is what argues for the kernel; this file
  argues for the *response*.
