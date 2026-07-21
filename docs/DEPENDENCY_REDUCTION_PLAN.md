# Dependency Reduction Plan

> Generated 2026-07-21 via `bunx knip`, `bun pm ls`, `du -sh node_modules`.

## Current State

| Metric | Value |
|--------|-------|
| `bun pm ls` line count | 80 |
| `node_modules` disk usage | 1.6 GB |
| Unused files (knip) | 45 |
| Unused dependencies (knip) | 9 |
| Unused devDependencies (knip) | 25 |

---

## Root `package.json` devDependencies Classification

| Package | Classification | Rationale |
|---------|---------------|-----------|
| `@biomejs/biome` | KEEP_CORE | Linter/formatter used by `lint`, `format` scripts across all packages |
| `@changesets/cli` | KEEP_CORE | Release management for the monorepo |
| `@changesets/changelog-github` | REMOVE | Detected unused by knip; changelog generation can use the simpler `@changesets/changelog-git` (already unlisted dep) |
| `@cyclonedx/cyclonedx-npm` | KEEP_OPTIONAL | SBOM generation (`sbom` script); only needed for compliance workflows |
| `@types/node` | KEEP_CORE | TypeScript type definitions for all packages |
| `happy-dom` | MOVE_TO_EXAMPLES | Detected unused by knip at root; only referenced in test environments for UI packages |
| `node-llama-cpp` | MOVE_TO_INTEGRATIONS | Local LLM inference; belongs in `packages/model-local` devDeps |
| `turbo` | KEEP_CORE | Monorepo build orchestrator |
| `typescript` | KEEP_CORE | Language compiler for all packages |
| `vitepress` | KEEP_OPTIONAL | Documentation site; could be extracted to a separate docs workspace |

---

## Workspace Package Groups

### Core Runtime (`KEEP_CORE`)

These packages form the published product surface:

- `packages/core` — Agent runtime, executor, planner
- `packages/aep` — Audit/attestation protocol
- `packages/mcp-firewall` — MCP request filtering
- `packages/compliance` — Policy enforcement
- `packages/kernel-wasmtime` — WASM sandbox kernel
- `packages/kernel-quickjs` — QuickJS sandbox kernel

### Model Adapters (`MOVE_TO_INTEGRATIONS` as a group)

All `packages/model-*` packages (anthropic, openai, deepseek, doubao, minimax, moonshot, qwen, zhipu, local) share a pattern:

- Each declares `openai` or `@anthropic-ai/sdk` as a devDependency
- Knip flags many of these as unused devDeps because they are peer dependencies used at runtime by consumers
- **Recommendation**: Convert to `peerDependencies` with optional flag; move test fixtures inline.

### Integration / Platform Adapters (`MOVE_TO_INTEGRATIONS`)

- `packages/cloudflare-worker`
- `packages/aisdk`
- `packages/claude-agent-sdk`
- `packages/openai-agents`
- `packages/mastra-sandbox`
- `packages/ag-ui`
- `packages/a2a`

### Developer Tooling (`KEEP_OPTIONAL`)

- `packages/cli`
- `packages/devtools`
- `packages/evals-runner`
- `packages/otel-exporter`

### UI Packages (`MOVE_TO_EXAMPLES`)

- `packages/ui-cards`
- `packages/ui-cards-react` (has unused devDeps: `@terrastruct/d2`, `jsdom`)

---

## Specific Recommendations

### REMOVE (immediate)

| Dependency | Location | Reason |
|-----------|----------|--------|
| `@changesets/changelog-github` | root `package.json` | Unused; `.changeset/config.json` references `@changesets/changelog-git` |
| `happy-dom` | root `package.json` | Not imported at root level; move to packages that need it |

### REPLACE

| Dependency | Location | Replace With | Reason |
|-----------|----------|--------------|--------|
| `node-llama-cpp` (root) | root `package.json` | Move to `packages/model-local` | 300+ MB native binary; should not be installed for all contributors |

### MOVE_TO_EXAMPLES

| Dependency | Current Location | Target |
|-----------|-----------------|--------|
| `@wasmagent/core` | `examples/a2a-interop` | Already correct; knip false positive (workspace link) |
| `@anthropic-ai/sdk` | `examples/basic-agent`, `examples/tool-calling-agent` | Already correct placement |

### MOVE_TO_INTEGRATIONS

| Dependency | Current Location | Reason |
|-----------|-----------------|--------|
| `@wasmagent/devtools` | `packages/evals-runner` | Only used for eval dashboard; not core |

---

## Estimated Impact

| Action | Estimated Savings |
|--------|------------------|
| Remove `node-llama-cpp` from root | ~500 MB node_modules |
| Remove `happy-dom` from root | ~5 MB |
| Convert model adapter SDKs to peerDeps | Faster installs for CI (no duplicate hoisting) |
| **Total estimated reduction** | **~30-40% of node_modules size** |

---

## Next Steps

1. Remove `@changesets/changelog-github` and `happy-dom` from root `package.json`
2. Move `node-llama-cpp` to `packages/model-local/package.json` devDependencies
3. Audit model adapter packages: convert SDK deps to peerDependencies
4. Consider extracting `vitepress` docs into a separate workspace with its own install
5. Clean up 45 unused files detected by knip (examples/benchmarks scripts, old fixtures)
