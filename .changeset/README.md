# Changesets

This folder contains release coordination for `agentkit-js` published packages.

- `config.json` — release policy (linked versions across `@agentkit-js/*`, public access).
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

`@agentkit-js/cloudflare-worker` is `private: true` and ignored by changesets — it ships only via Workers deploy, never to npm.
