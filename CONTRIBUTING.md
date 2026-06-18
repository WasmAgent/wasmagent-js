# Contributing to agentkit-js

> First-time contributors are welcome. The project is small enough that
> one well-scoped PR can move the needle.

## Looking for a co-maintainer

agentkit-js currently has a single primary maintainer. The single
fastest way to materially help the project is to volunteer for
**npm-publish + merge rights**. We are explicitly looking for
contributors embedded in one of: Vercel AI SDK, Mastra, Claude
Agent SDK, OpenAI Agents JS, Cloudflare Agents SDK, or LangGraph.js
communities — those are the upstream surfaces our adapter packages
target ([`ROADMAP.md`](ROADMAP.md) S1, strategy memo's L1).

The role is described in
[`GOVERNANCE.md`](GOVERNANCE.md#how-decisions-get-made-when-we-have-2-maintainers)
and is on the 2026-12-15 1.0-freeze checklist
([`docs/strategy/api-stability.md`](docs/strategy/api-stability.md#10-freeze-schedule)).
Open an issue tagged `governance:co-maintainer-interest` with a
short note about how you'd use the role; bring a recent PR you've
landed in the upstream you're embedded in if you have one.

## Quick start

```bash
git clone https://github.com/telleroutlook/agentkit-js
cd agentkit-js
bun install      # turbo + workspaces; pnpm/npm also work
bun run build    # tsc across all packages
bun run test     # vitest across all packages
bun run lint     # biome
```

## Where to start (good first issues)

Plugin packages are the easiest entry — they are small, opinion-free
adapters with clear public contracts:

- **`@agentkit-js/aisdk`** — write a recipe + test for an AI SDK tool
  pattern your app uses.
- **`@agentkit-js/mastra-sandbox`** — wire a different `Kernel`
  (Pyodide, Wasmtime) into the example test.
- **OpenAI-compat recipes** — add a working snippet to
  [`docs/guides/openai-compat-recipes.md`](docs/guides/openai-compat-recipes.md)
  for the provider you use. New providers land here, not as a new
  `model-*` package (see [ROADMAP.md](ROADMAP.md) — "Explicitly NOT on the roadmap").

Larger items live on the [ROADMAP](ROADMAP.md). Tag a maintainer in an
issue before starting on a roadmap item to confirm scope.

## How we work

- **Small PRs.** Squash-merging a 600-line "ship A → F → B" omnibus
  was the historical pattern; we are moving to one PR per logical
  chunk. The `git log` becomes the activity signal new contributors
  scan when deciding whether to invest time here.
- **One RFC per public-API change.** Drop a markdown file under
  `docs/rfcs/<short-name>.md` with three sections: **Problem**,
  **Proposed shape**, **Why-not**. Open the implementation PR after
  the RFC has settled. Trivial doc / dependency / typo PRs skip this.
- **Tests near code.** Each `*.ts` file lives next to its `*.test.ts`.
  Vitest for everything.
- **Comments where it matters.** Match the existing style: comments
  explain *why* (the trade-off, the constraint, the historical
  decision), not *what*. The repository's tone is calm and direct;
  match it.
- **No hand-typed dates.** When you reference a commit / changelog /
  release date in a comment, write the actual ISO date — `2026-06-12`,
  not "today" or "now". This file is one concrete example.

## Checks that block a merge

- `bun run lint` — biome: clean, no `--no-verify` overrides.
- `bun run typecheck` — no `any` regressions, no `@ts-ignore` without
  a one-line comment explaining why.
- `bun run test` — vitest: all packages green.
- `node examples/benchmarks/run-all.mjs` — README claims hold to
  their declared tolerance. CI gate.
- For changes inside `packages/kernel-*` — the cross-kernel
  capability test in `packages/core/src/executor/capabilities.test.ts`
  must still pass.

## Security-relevant changes

If your PR touches any kernel source, the security policy face
(`packages/core/src/executor/capabilities.ts`,
`packages/core/src/executor/types.ts`), or the MCP server's
`createCodeModeServer`:

- Tag the PR `security`.
- Add tests for the capability path that you changed (positive +
  negative assertion).
- Don't ship a workaround that loosens an existing capability default
  without a corresponding tightening elsewhere.

The disclosure SLA for sandbox-escape reports lives in
[SECURITY.md](SECURITY.md).

## Releasing

Publish releases land via the GitHub Actions release workflow when a
maintainer tags `v<version>` on `main`. Do not hand-publish from a
dev machine. The current version manifest is `packages/*/package.json`;
align bumps via changesets when bumping more than one package.

## Generic-first discipline (S4)

Anything that is not strictly product-specific lands in `agentkit-js`
*first* and is consumed by `bscode` or any other downstream as a
public API. This is not a stylistic preference — it is the rule that
keeps `bscode` a funnel rather than a competing product (see
[`ROADMAP.md`](ROADMAP.md) S4).

Concretely, before opening a PR in the `bscode` repo that adds a new
tool, scorer, judge, runner, or workspace abstraction, ask:

1. **Is the logic specific to this product, or would another agent
   project want it?** If the second answer is yes, the PR belongs in
   `agentkit-js`, with `bscode` consuming the published package.
2. **Does it depend only on already-published `@agentkit-js/*` APIs?**
   If it would force an internal-only import, the missing public API
   is the actual blocker — land that first.
3. **Is there a comparable feature already in `agentkit-js` you
   would otherwise duplicate?** If yes, extend the framework instead.

PRs in `bscode` that fail this test will be redirected to land the
generic piece here first. Reviewers should reference S4 by name in
the redirect, so the rule is visible to future contributors.

## Differentiation gets documented in the same PR (S5)

When a PR adds, sharpens, or removes a **differentiation axis** —
something a reader of `README.md` or `docs/compare.md` would scan to
decide whether agentkit-js is worth picking — the *narrative for that
axis lands in the same PR as the code*. Code without a narrative is
silent: `git log` cannot reconstruct why a class was added, and the
next reader (human or LLM) has to infer it from filenames.

A differentiation-axis PR includes **at minimum**:

1. **A guide page** under `docs/guides/` explaining what the axis
   does, when to use it, and how it composes with existing axes. If a
   guide already exists, extend it rather than creating a sibling.
2. **A line on the comparison table** — either `README.md`'s 8-axis
   table at the top, or `docs/compare.md`'s row-per-feature grid.
   "Status: shipped 2026-06-18" with a link to the guide is enough.
3. **One end-to-end evidence artefact**, kept in `docs/eval-reports/`
   or `docs/strategy/`. This can be a CLI baseline transcript, a
   short ablation, or a comparison run; what matters is that someone
   reading the PR sees the axis *demonstrated*, not just declared.
4. **A strategy doc entry** when the axis is large enough that the
   roadmap or the competitive table shifts. The `docs/strategy/YYYY-MM-DD-<topic>.md`
   pattern (see [2026-06-17 update](docs/strategy/2026-06-17-update.md),
   [2026-06-18 update](docs/strategy/2026-06-18-goal-directed-shipped.md))
   is the convention. One short doc per *delta day* is better than
   one long doc per quarter — the day-stamp keeps the narrative
   composable.

This rule is the dual of S4. S4 keeps the *code* neutral and
foundation-shaped; S5 keeps the *narrative* visible. Without S5, an
axis can ship correctly but stay invisible to anyone who doesn't read
diffs — which is the audience that decides whether the project is
worth depending on. The cost is small (an hour of writing per
shipping day) and the leverage is large (the docs become the project's
primary surface; reviewers and future maintainers reuse the framing
for free).

If you are unsure whether a PR triggers this rule, the test is: *would
a reader of the README's comparison table notice the change?* If yes,
S5 applies. Trivial fixes, refactors, and dependency bumps don't.

## Co-maintainers wanted

The repository is currently single-maintainer; we are explicitly
recruiting co-maintainers. Decision rights, the path in, and the SLAs
we are working to are all written down in
[`GOVERNANCE.md`](GOVERNANCE.md).

## AI-assisted contributions (transparency policy)

A meaningful portion of the commit history in this repository was
authored with help from an LLM-based coding assistant (Claude). We
think this is fine — Apache-2.0 makes no special claim about the
authoring tool — but we want the practice to be **visible** rather
than hidden, so reviewers and downstream auditors can form their
own opinion.

**Our policy, in three rules:**

1. **Every commit is reviewed and accepted by a human maintainer
   before it lands on `main`.** The maintainer takes responsibility
   for the change — what the LLM produced is treated as a draft,
   not a finished patch. If a generated change passes review and
   ships, the bug it later causes is the maintainer's bug to fix.

2. **Substantial AI-assisted contributions should add a
   `Co-authored-by:` trailer** of the form
   `Co-authored-by: Claude <noreply@anthropic.com>` (or the
   equivalent for whichever assistant you used). This is the same
   GitHub-recognised trailer used for paired human authorship. It
   does not transfer copyright (the human author still owns the
   contribution under Apache-2.0) — it documents the working
   method.

3. **Don't paste assistant output you don't understand.** If you
   cannot explain why a generated diff is correct, do not commit
   it. This is the load-bearing rule; the trailer is bookkeeping.

We are following the patterns the OSI's "AI and open source"
working group and SFC have been recommending — write down what's
happening, give the human author the responsibility, and let
downstream consumers see the working method. If you have feedback
on this policy, open an issue tagged `governance` and we'll revisit
it.

## Code of conduct

Be kind. Disagree on the substance, not the contributor.
