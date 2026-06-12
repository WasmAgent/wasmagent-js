# Contributing to agentkit-js

> First-time contributors are welcome. The project is small enough that
> one well-scoped PR can move the needle.

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

## Code of conduct

Be kind. Disagree on the substance, not the contributor.
