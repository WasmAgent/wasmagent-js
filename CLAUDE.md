# wasmagent-js — Development Guide for Claude

## What this project is (and is not)

**Is:** Verifiable evidence layer + security control plane for MCP and tool-using agents.
Three public entry points: `@wasmagent/mcp-firewall` (protect), `@wasmagent/aep` (record), `@wasmagent/compliance` (audit+train).

**Is NOT — do not implement these:**
- A general-purpose agent framework (LangChain / Mastra / AutoGen territory)
- A Cursor / Claude Code / Codex competitor (no IDE UX, no remote execution at scale)
- A compliance certification tool (never claim "satisfies EU AI Act / ISO 42001")
- A universal RAG / workflow engine
- A training framework (TRL / Axolotl territory) — we produce training *data*, not training *code*

## Test Commands

**IMPORTANT: This project uses `bun test` (not `npx vitest run`, not `npm test`).**

```bash
# Run all tests from repo root
bun test packages/core/src/
bun test packages/cloudflare-worker/src/   # --isolate is baked into bunfig.toml, no flag needed
bun test packages/cli/
bun test packages/model-anthropic/src/
# etc.

# DevTools (React/DOM tests) MUST be run from within the package directory:
cd packages/devtools && bun test

# Run a specific test file
bun test packages/core/src/agents/ToolCallingAgent.test.ts

# RLAIF-specific test suites
bun test packages/core/src/enhancement/RolloutForkRunner.test.ts
bun test packages/core/src/ranking/RolloutRanker.test.ts
bun test packages/core/src/executor/KernelPool.test.ts
bun test packages/core/src/agents/verifiers/BuildPassesVerifier.test.ts
```

**Why devtools is different**: It needs DOM environment (happy-dom). The `bunfig.toml` in
`packages/devtools/` configures this via a preload script (`src/setup-dom.ts`), but Bun only
reads `bunfig.toml` from the CWD where `bun test` is invoked.

**cloudflare-worker isolation**: The SSE resume test leaves a pending async operation that would
hang the process at ~90% CPU forever. `packages/cloudflare-worker/bunfig.toml` sets
`isolate = true` permanently — `bun test` is safe to call without any extra flags.

**CRITICAL: Never run any `bun test` as a background task** (`run_in_background`) — a hung test
will silently burn CPU for hours with no way to detect it.

## Lint

```bash
npx biome check packages/
npx biome check --write packages/    # auto-fix
```

## Build

```bash
npm run build          # build all packages via turbo
```

## Typecheck

```bash
npm run typecheck      # turbo run typecheck across all packages
```

## Integration tests

```bash
bun test tests/integration/
```

## Local–CI parity (MUST READ before pushing > 50 lines)

`bun test` passing locally does **not** guarantee CI green. CI runs three more
checks in addition to `bun test`, and several of them have caught us recently:

```bash
# Reproduce CI locally before push — run all four:
npx biome check packages/                  # CI's "Lint" job
npm run typecheck                          # CI's "Typecheck" job (tsc emit, NOT --noEmit)
bun test packages/<changed>/src/           # CI's "Test" job
npm run build                              # CI's "Build" job (Release-only)
```

### Foot-guns observed in the wild

1. **`bun test` ≠ CI typecheck.** `bun test` doesn't compile — `tsc` does, and
   it surfaces errors `bun` ignores. Always run `npm run typecheck` before push.

2. **`tsc -p tsconfig.json` (emit) is stricter than `tsc --noEmit`.** Some
   packages use `noUncheckedIndexedAccess: true` + `exactOptionalPropertyTypes:
   true`. `bun run build` in those packages catches errors that `tsc --noEmit`
   misses. Run `npm run build` before push.

3. **`biome check --write --unsafe` strips non-null assertions (`!`).** The
   strip can resurrect TS2532 (`Object is possibly 'undefined'`) errors that
   were previously suppressed. Pattern:
   ```ts
   // ❌ biome --unsafe will strip the `!` and tsc fails next time
   const b = arr[i]!;
   // ✅ explicit fallback survives biome and satisfies tsc
   const b = arr[i] ?? 0;
   ```
   Use `?? 0` / `?? defaultValue` for numeric / scalar fallbacks, or an
   explicit early-return for refs that should never be undefined.

4. **`exactOptionalPropertyTypes: true` distinguishes `undefined` from
   absence.** Passing `{ revokedJti: undefined }` is **not** equivalent to
   omitting the key — tsc rejects it. Build the opts object conditionally:
   ```ts
   const opts: Foo = { a: 1, b: 2 };
   if (revokedJti !== undefined) opts.revokedJti = revokedJti;
   ```

5. **NUL bytes (`\x00`) in source files are silently accepted by git.** They
   make `awk`, `cat`, `grep`, and `file` report the file as binary, and biome
   reports them as `noControlCharactersInRegex` errors. They typically sneak
   in when a regex literal like `/[\x00-…]/` is hand-typed. Use explicit
   ` `/`` Unicode escapes instead:
   ```ts
   // ❌ NUL byte literal — file becomes "binary", grep can't find it
   const re = /[\x00-…]/;
   // ✅ escape sequences — safe
   const re = /[ -ɏ]/;
   ```

### Pre-push checklist (recommended)

For commits that touch source files (not just docs / changesets), run before
`git push`:

```bash
npx biome check packages/ && \
  npm run typecheck && \
  npm run build && \
  bun test packages/<changed>/src/
```

If any step fails, fix it before pushing. CI is not a substitute for local
verification — every red CI run wastes ~3–6 minutes of feedback latency.

## changeset release flow (publish via two-stage PR)

There are two npm-publishing paths in this repo. **Use the right one** —
mixing them creates phantom versions and broken release PRs.

### Path A: `changeset publish` (the everyday release path)

For any change to a package that's already on npm. Workflow:

```bash
# After landing your change on main:
1. Author writes .changeset/<name>.md describing what changed (see existing files for shape)
2. Push to main. .github/workflows/release.yml triggers and auto-opens
   "chore: release packages" PR using changesets/action.
3. Review the auto-generated CHANGELOG diff + version bumps in the PR.
4. Merge the PR — release.yml fires again, this time running
   `changeset publish` which actually publishes to npm.
```

**Semantics of `.changeset/config.json` `linked` and `ignore`:**

- `linked: [['@wasmagent/*']]` does **not** mean "every `@wasmagent/*` bumps
  together unconditionally." It means "packages mentioned in a changeset
  *plus packages that depend on them transitively* all share the same version
  number." A changeset that lists 5 packages still only bumps those 5
  (plus their dependents) — not the entire `@wasmagent/*` namespace.
- `ignore: ['@wasmagent/cloudflare-worker', ...]` excludes from **version
  bumping**, but `changeset publish` will still try to publish if it sees a
  local version that's not on npm. To skip publishing entirely, keep
  `"private": true` in `package.json`.

### Path B: `publish-alpha.yml` (first-time publish only)

Only when a brand-new scoped package has never appeared on npm. See the
detailed steps in "Publishing new npm packages" below. **Do not** use
`publish-alpha` for packages already on npm — `changeset publish` is the
correct path for updates.

### Common transient failures

- **Release workflow "Premature close"** from GitHub GraphQL API while
  generating changelog. Just re-run: `gh run rerun <id> --failed`. Not a
  bug in your changes.

- **Release PR shows `UNSTABLE`** mergeable state with "no checks reported".
  The PR branch `changeset-release/main` doesn't have its own CI run because
  the workflow filter excludes that branch. The content has already been
  validated by the main-branch CI that produced it. Safe to merge.

- **`npm error 404 ... not in this registry`** on a package that you
  *know* exists on npm. This is almost always an `NPM_TOKEN` scope or
  expiry problem, not a registry problem. Check the token's package-scope
  access at `npmjs.com/settings/<org>/tokens`.

### Preventing E404 forever — migrate to Trusted Publisher (recommended)

The long-term fix for "npm publish returns 404 even though the package
exists" is to stop using long-lived `NPM_TOKEN` secrets entirely and
adopt npm's [Trusted Publisher (OIDC)](https://docs.npmjs.com/trusted-publishers).

**One-time setup:**

1. On `npmjs.com/settings/wasmagent/publishing-access` (org-level), or on
   each package's "Publishing access" page, add the workflow as a Trusted
   Publisher:
   - Repository: `WasmAgent/wasmagent-js`
   - Workflow: `.github/workflows/release.yml`
   - Environment: (leave blank)
2. In `.github/workflows/release.yml`, delete the `Set npm registry` step
   and the `NPM_TOKEN` env on `changesets/action`. The `permissions:
   id-token: write` we already have lets npm CLI 9+ negotiate OIDC.
3. Revoke the old `NPM_TOKEN` secret on the repo + on npm.

**Verifying the migration:**

```bash
# Dry-run a release locally — must NOT prompt for credentials
gh workflow run release.yml --ref main
gh run watch  # confirm "npm notice publish Signed provenance" + no 404
```

### Pre-publish checklist (run before triggering a release)

```bash
# 1. NPM_TOKEN still valid (skip after Trusted Publisher migration)
gh secret list --repo WasmAgent/wasmagent-js | grep NPM_TOKEN
# Updated within last 60 days. If older, rotate via npm Granular Token.

# 2. Local dry-run of the package you most care about
cd packages/aep && npm publish --dry-run --access public

# 3. Local check:all
npx biome check packages/ && npm run typecheck && npm run build && \
  node scripts/check-version-coherence.mjs

# 4. Verify changeset will produce the expected version bumps
npx changeset status
```

If any of these fail, the Release workflow will fail the same way — fix
locally first.

## Key modules (2026-06-26)

| Module | Location |
|---|---|
| `RolloutForkRunner` | `packages/core/src/enhancement/RolloutForkRunner.ts` |
| `KernelPool` | `packages/core/src/executor/KernelPool.ts` |
| `BuildPassesVerifier` / `VisualAssertVerifier` / `ScalarLLMJudgeVerifier` | `packages/core/src/agents/verifiers/` |
| `RolloutRanker` | `packages/core/src/ranking/RolloutRanker.ts` |
| `AEPRecord` / `AEPEmitter` / `BudgetLedger` | `packages/aep/src/` (`@wasmagent/aep`) |
| `AEP_SPAN_NAMES` / `GENAI_SEMCONV` / `aepActionToOtelSpan` | `packages/otel-exporter/src/` |
| `MCPGateway` / `RequestIdentity` / `ServerCard` / `ScopeLease` / `ApprovalReceipt` | `packages/mcp-firewall/src/gateway.ts` |
| `GatewayMiddleware` / `composeMiddleware` | `packages/mcp-gateway/src/` (`@wasmagent/mcp-gateway`) |
| `PolicyBundle` / `PolicyBundleMetadata` | `packages/mcp-policy/src/` (alpha, private) |
| `CapabilityAttestation` / `AttestationRegistry` | `packages/mcp-attestation/src/` (alpha, private) |
| `buildDelegationContext` | `packages/core/src/agents/AgentTeam.ts` |

## Compliance Engine + Security (2026-06-26)

WasmAgent Compliance Engine — TaskSpec → ConstraintIR → Verifier → RepairTrace
pipeline. Lives at `packages/compliance/` (`@wasmagent/compliance`).

**Runtime compliance source of truth.** `ComplianceEvalRecord` is the canonical
cross-repo data contract consumed by evomerge for SFT/DPO/router training.
See [ecosystem-map](https://github.com/WasmAgent/trace-pipeline/blob/main/docs/ecosystem-map.md).

### Package maturity

Five-tier scale: **stable** | **beta** | **alpha** | **demo** | **research**
- **stable**: public API locked; breaking changes require a major-version bump; semver guaranteed.
- **beta**: functional and production-used, but a specific documented limitation applies (e.g. first-line filter only, or a contract field still evolving).
- **alpha**: schema versioned; fields may be added without a breaking-change bump.
- **demo**: demonstration/example code; not hardened for production.
- **research**: research-grade prototype; interfaces may change without notice.

| Package | Maturity | Notes |
|---|---|---|
| `@wasmagent/core` | **stable** | Public API; semver guaranteed |
| `@wasmagent/kernel-quickjs` | **stable** | |
| `@wasmagent/kernel-remote` | **stable** | |
| `@wasmagent/mcp-gateway` | **stable** | Published 0.1.0; composes all firewall layers |
| `@wasmagent/mcp-firewall` | **beta** | First-line filter, not adversarial-grade — keyword bag + lightweight n-gram classifier; use defence-in-depth; ScopeLease, ApprovalReceipt, vetTool |
| `@wasmagent/aep` | **beta** | v0.2 Ed25519 signature contract shipped; schema versioned (v0.1/v0.2) |
| `@wasmagent/otel-exporter` | **alpha** | GENAI_SEMCONV, AEP↔OTel bridge |
| `@wasmagent/aisdk` / `@wasmagent/mastra-sandbox` | **alpha** | API stable, may add fields |
| `@wasmagent/compliance` | **alpha** | Schema versioned; may add fields without breaking |
| `@wasmagent/mcp-policy` | **alpha — private** | Not yet published to npm |
| `@wasmagent/mcp-attestation` | **alpha — private** | Not yet published to npm |
| `@wasmagent/evals-runner` | **alpha** | |
| `@wasmagent/devtools` | **alpha** | |

### Compliance modules

| Module | Location |
|---|---|
| `ConstraintIR` / `TaskSpec` types | `packages/compliance/src/ir/ConstraintIR.ts` |
| `ComplianceVerifier` | `packages/compliance/src/verifier/ComplianceVerifier.ts` |
| `IFEvalVerifier` (15 instruction classes) | `packages/compliance/src/verifier/ifeval/IFEvalVerifier.ts` |
| `DeterministicVerifier` (7 built-in checks) | `packages/core/src/agents/verifiers/DeterministicVerifier.ts` |
| `LLMJudgeVerifier` (adversarial binary) | `packages/core/src/agents/verifiers/LLMJudgeVerifier.ts` |
| `RepairPlanner` (escalation + rollback) | `packages/compliance/src/repair/RepairPlanner.ts` |
| `PatchStrategy` / `InsertSectionStrategy` / `RegenerateRegionStrategy` | `packages/compliance/src/repair/strategies/` |
| `ComplianceRun` (direct / prompt_retry / full_pcl) | `packages/compliance/src/runner/ComplianceRun.ts` |
| IFEval benchmark CLI (9 seeds complete) | `packages/compliance/benchmarks/ifeval/run.ts` |
| Multi-seed aggregator | `packages/compliance/benchmarks/ifeval/compare-seeds.ts` |
| Result data (1050 records) | `packages/compliance/benchmarks/ifeval/results*/` |
| Phase reports | `packages/compliance/benchmarks/ifeval/results-multi-seed*/*.md` |

**Headline empirical result**: on IFEval × Qwen2.5-1.5B-Q4, `full_pcl`
achieves 54.7% ± 1.2 pass-rate vs `prompt_retry` 46.0% ± 2.0 (+8.7 pp,
3 seeds × 50 samples). On Llama-3.2-1B, the picture is more complex —
PCL ties prompt_retry on mean but has 5× smaller variance. See
`packages/compliance/benchmarks/ifeval/results-multi-seed-llama/CROSS-MODEL-2026-06-24.md`.

Test it: `bun test packages/compliance/` (113 pass / 0 fail).
Reproduce sweep: `bun packages/compliance/benchmarks/ifeval/run.ts --limit=50 --seed=42`.

## Publishing new npm packages (MUST READ before adding new public packages)

**The Release workflow (`changeset publish`) fails with E404 on brand-new scoped packages
that have never existed on npm.** `changeset`'s `ignore` list only affects version bumping,
NOT publishing — it will still attempt to publish any un-published version.

### Correct procedure for first-time publishing a new package

1. Add all required package.json fields (checked by `publish-check.mjs`):
   - `homepage`, `repository`, `publishConfig: { access: "public" }`, `files`, `license`
   - `wasmagent.tier` and `wasmagent.stability` must be one of `"stable"`, `"beta"`, `"alpha"`, `"demo"`, or `"research"` (five-tier scale; `"experimental"` is no longer a valid value)
   - `README.md` and `LICENSE` must exist in the package directory

2. Keep `"private": true` in package.json to prevent changeset from attempting publish.

3. Add the package to `.changeset/config.json` `ignore` list.

4. **First publish: use the `publish-alpha` workflow** (Actions → Publish Alpha Packages):
   - Set `packages` to the package directory name (e.g. `aep mcp-gateway`)
   - Set `dry_run: false`
   - The workflow removes `private: true` temporarily, publishes, then the local file change is not committed
   - **OR** publish locally: `cd packages/<name> && npm publish --access public` (after removing `private: true` from package.json)
   - After successful publish, E403 "cannot publish over previously published" confirms it worked

5. After first publish succeeds (verify with `npm view @wasmagent/<name>`):
   - Remove `"private": true` from package.json
   - Remove the package from `.changeset/config.json` ignore list
   - Commit and push → subsequent Release workflow runs will manage versions via changeset normally

6. **npm CDN propagation can take 2–5 minutes** after publish. E404 immediately after
   a successful publish (`+ @wasmagent/xxx@0.1.0` in output) is normal — wait and retry.

