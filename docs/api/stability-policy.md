# API Stability Policy

This document defines the stability contract for all wasmagent-js public APIs.

---

## Stability Tiers

Each package and export is assigned a tier via the `wasmagent.tier` field in its `package.json`.

| Tier | Name | Breaking change policy | CI gate |
|---|---|---|---|
| **tier-0** | SemVer stable | Breaking changes only in major releases | Strong: any regression blocks CI |
| **tier-1** | Stable with minor extensions | Minor additive extensions allowed; no silent breaking changes; changelog entry required | Moderate: removals and signature changes block CI |
| **tier-2** | Best-effort | Tracks upstream changes; may change in minor releases without a deprecation window | Advisory only |
| **tier-3** | Experimental | Explicitly experimental; may change or be removed in any minor release | None |

---

## Stable Export List

`docs/api/stable-api-snapshot.json` records the **275 stable exports** that are protected under the tier-0/tier-1 contract.

The CI script `check-stable-api.mjs` runs on every pull request and compares the current public exports of `@wasmagent/core` against the snapshot. Any removal or rename that is not paired with a matching snapshot update causes CI to fail, preventing accidental breaking changes from landing.

A human-readable, alphabetically sorted version of the same list is available at [docs/api/stable-exports.md](./stable-exports.md).

---

## Breaking Change Policy

- **Stable exports (tier-0 / tier-1):** Breaking removals or incompatible signature changes may only ship in a **major release** (`X.0.0`). A deprecation notice must appear in the preceding minor release when practical.
- **Beta / experimental packages (tier-2 / tier-3):** Breaking changes are allowed in minor releases but **must be explicitly called out** in the changelog under the `### Experimental changes` or `### Beta changes` section.
- **Additive changes** (new exports, new optional parameters, new enum values) are always allowed in minor releases for all tiers.

---

## Release Changelog Format

Every release entry in `CHANGELOG.md` is structured into three sections, one per stability tier group:

```markdown
## v<X.Y.Z> — <date>

### Stable changes
<!-- tier-0 and tier-1 changes; breaking changes only on major releases -->

### Beta changes
<!-- tier-2 changes; breaking changes allowed, must be explicitly noted -->

### Experimental changes
<!-- tier-3 changes; anything goes, noted for transparency -->
```

Consumers who only depend on tier-0/tier-1 exports can safely scan the `### Stable changes` section and ignore the rest.
