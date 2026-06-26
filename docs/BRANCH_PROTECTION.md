# Branch Protection — operational guide

> **Scope.** This document is the shared operational manual for branch
> protection across all three WasmAgent open-source repositories:
> [`wasmagent-js`](https://github.com/WasmAgent/wasmagent-js),
> [`bscode`](https://github.com/WasmAgent/bscode), and
> [`trace-pipeline`](https://github.com/WasmAgent/trace-pipeline).
> The settings below apply to every `main` branch in the org. Sibling
> repos link here instead of forking the content — when the protocol
> changes, update this file only.

The pre-push hook (`.githooks/pre-push`) blocks the developer's own bad
pushes. Branch protection on GitHub blocks bad pushes from *every* path
(direct push, merged PR with stale CI, force-push from another machine
with hooks disabled, etc.). This is the final defence layer.

## Why we want it

Tonight (2026-06-26) we pushed four red commits to `main` in a row, each
caught only by CI, costing ~3–6 min of feedback latency per round. With
branch protection on:

1. The first red push would have been **rejected at the server**,
2. The author would have opened a PR instead,
3. The PR would have run CI before being mergeable,
4. No red commit ever lands on `main`.

## Recommended settings

Owner-only action — for each repo:

- `https://github.com/WasmAgent/wasmagent-js/settings/branches`
- `https://github.com/WasmAgent/bscode/settings/branches`
- `https://github.com/WasmAgent/trace-pipeline/settings/branches`

Add a rule for `main` with:

| Setting | Value | Why |
|---|---|---|
| Require a pull request before merging | ☑ | No more direct push to main |
| Required approvals | 0 (or 1 if you add a co-maintainer) | We don't have reviewers yet |
| Dismiss stale PR approvals when new commits are pushed | ☑ | Approvals stay honest |
| Require status checks to pass | ☑ | Hook the CI workflows below |
| Required checks (per repo) | see "Required checks per repo" below | These are the workflows that run on every push |
| Require branches to be up to date before merging | ☑ | Avoids "passed CI on old base" surprise |
| Require conversation resolution before merging | ☑ | Catches review comments |
| Require signed commits | ☐ | Add later if you set up GPG |
| Require linear history | ☑ | Cleaner CHANGELOG, easier bisect |
| Do not allow bypassing the above settings | ☑ (Administrators included) | Bind ourselves |

### Required checks per repo

| Repo | Required check name(s) |
|---|---|
| `wasmagent-js` | `CI / Build, Typecheck & Test (1.3.14)` <br> `Release / release` *(optional but recommended)* |
| `bscode` | `CI / Typecheck, Test, Build` |
| `trace-pipeline` | `CI / lint-and-test` *(or whatever the active workflow is — check `gh run list --limit 1`)* |

If a workflow file is renamed, GitHub's UI search picks up the new name
automatically; you just need to re-select it in the rule. The check
name is the `name:` field of the workflow YAML, optionally followed by
` / <job-id>` if you wired more than one job in the same workflow.

## Workflow change for you and for Claude Code

After enabling, the audit-fix workflow that produced commit c8635dd
would have been:

```bash
# Old (tonight):
git push origin main           # CI runs after the fact

# New:
git checkout -b fix/audit-2026-06-26
git push -u origin fix/audit-2026-06-26
gh pr create --title "Audit fixes (P0/P1)" --body "..."
# CI runs on the PR. Once green:
gh pr merge --squash --auto
```

The pre-push hook still fires before *every* push to *any* branch.
Branch protection adds: "and CI must also be green before merging
into main."

## What the `Release` workflow looks like after enabling

Branch protection does NOT block the `chore: release packages` PR that
changesets/action opens — that PR is created by `github-actions` bot
and the protection rule can either:

(a) require the same CI checks for the release PR too (recommended,
    catches the rare case where bumping versions breaks something), or
(b) exclude `github-actions` bot from "required approvals" (optional —
    saves a click when nothing else is in flight).

We recommend (a).

## Rollout plan

1. Owner enables the rule on `main` in each of the three repos.
2. Run `bash .githooks/install.sh` on every dev machine so local hooks
   match server policy. New clones must do this once per repo.
3. Existing in-flight `git push origin main` workflows fail with a
   helpful message — switch them to PR-based.
4. After two weeks, evaluate: turn on Require Signed Commits if smooth.

## Related docs

- `CLAUDE.md` (per-repo) — local–CI parity, foot-guns, release flow.
  In `wasmagent-js`, see the "Release & publish" section.
- `.githooks/pre-push` — the local mirror of CI required checks.
- `.changeset/` (wasmagent-js only) — version bump semantics & policy.

