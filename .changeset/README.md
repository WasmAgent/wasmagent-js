# Changesets

This folder contains release coordination for `WasmAgent` published packages.

- `config.json` — release policy (linked versions across `@wasmagent/*`, public access).
- `*.md` — pending changesets describing what changed in upcoming releases. Each is consumed by `bunx changeset version` and turned into CHANGELOG entries + version bumps.

## Workflow

```bash
# describe a change you've just landed
bunx changeset

# bump versions + write CHANGELOG (run once per release window)
bunx changeset version

# publish to npm — runs `npm publish` in every package whose version changed
bunx changeset publish
```

The publish step requires:

- `npm login` (or `NPM_TOKEN` in CI),
- `dist/` built for every changed package (`bun run build`),
- workspace `*` references handled — `changeset publish` rewrites them to the just-bumped semver before tarballing.

`@wasmagent/cloudflare-worker` is `private: true` and ignored by changesets — it ships only via Workers deploy, never to npm.

## Why we use `@changesets/changelog-git`, not `@changesets/changelog-github`

The GitHub-flavoured changelog generator (`@changesets/changelog-github`)
calls the GitHub GraphQL API to enrich commit messages with PR / author
links. As of 2026-06-26 its underlying `@changesets/get-github-info@0.8.0`
still pulls `node-fetch@2`, which has a keep-alive bug ([node-fetch#1219](https://github.com/node-fetch/node-fetch/issues/1219))
recently exposed by a Node `http.Agent` change ([nodejs/node#63989](https://github.com/nodejs/node/issues/63989)).
The bug surfaces as `Invalid response body while trying to fetch
https://api.github.com/graphql: Premature close`, and during 2026-06-26
testing it failed on **all 4 retries** on the GitHub Actions runner
fleet — not intermittent any more.

Tracking: [changesets/changesets#2123](https://github.com/changesets/changesets/issues/2123).

Once `@changesets/cli@^3` lands as stable (its `get-github-info@1.x` has
removed `node-fetch` and uses native fetch), we can switch back.
