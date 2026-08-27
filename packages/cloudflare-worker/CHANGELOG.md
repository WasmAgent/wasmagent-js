# @wasmagent/cloudflare-worker

## 0.2.1

### Patch Changes

- Updated dependencies [2f93dfc]
  - @wasmagent/core@3.4.0
  - @wasmagent/ag-ui@1.0.13
  - @wasmagent/kernel-quickjs@1.2.10
  - @wasmagent/models@2.0.6

## 0.2.0

### Minor Changes

- f7a6cc9: Publish `@wasmagent/cloudflare-worker` to npm (issue #363). Removes `"private": true`, sets `publishConfig.access: "public"`, declares the compiled `dist/index.js` / `dist/index.d.ts` entry points, ships `dist` + `LICENSE` + `README.md` in the tarball, and includes the package in the changesets Release workflow (removed from `.changeset/config.json#ignore`) so CI publishes it on tagged releases.
