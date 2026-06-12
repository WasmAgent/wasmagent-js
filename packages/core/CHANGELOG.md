# @agentkit-js/core

## 0.2.1

### Patch Changes

- [`54f22d2`](https://github.com/telleroutlook/agentkit-js/commit/54f22d2b035ea12e9326d00a1c1541d9b7b4a5a3) Thanks [@claude](https://github.com/claude)! - Smoke test: confirm GitHub Actions release workflow can publish via NPM_TOKEN.
  This patch bumps only @agentkit-js/core to verify the CI path end-to-end.

## 0.2.0

### Minor Changes

- [`8c7d015`](https://github.com/telleroutlook/agentkit-js/commit/8c7d015ef3a0ab3f10e48b593be44fd106d6b433) Thanks [@claude](https://github.com/claude)! - First public npm release.

  - All 26 publishable packages now carry standard npm metadata: `repository`,
    `homepage`, `bugs`, `engines`, `license` (Apache-2.0), `publishConfig`,
    per-package `LICENSE`, and a `files` whitelist.
  - Inter-package dependencies still use `workspace:*` in source — `changeset publish` rewrites them to semver at pack time.
  - `@agentkit-js/cloudflare-worker` remains private and ships only via Workers deploy.
