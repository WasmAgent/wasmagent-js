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

## Release & publish

### Local–CI parity (run before pushing source changes)

`bun test` passing locally does **not** guarantee CI green. The pre-push
hook (`.githooks/pre-push`) mirrors CI: lint → no-control-bytes →
version-coherence → typecheck → build → tests → publish-readiness.
Install once per clone: `bash .githooks/install.sh`. Bypass only in
emergencies: `git push --no-verify`.

Manual one-shot equivalent: `npm run check:all`.

**Foot-guns that bit us 2026-06-26:**

| Symptom | Cause | Fix |
|---|---|---|
| TS2532 "Object possibly undefined" after biome `--write --unsafe` | biome strips `!` non-null assertions | Use `?? 0` / `?? default` instead |
| Local `bun test` green, CI typecheck red | `tsc -p tsconfig.json` (emit) is stricter than `tsc --noEmit` | Run `npm run build` before push |
| `exactOptionalPropertyTypes` rejects `{x: undefined}` | Passing explicit undefined ≠ omitting key | Build opts object conditionally |
| File reads as binary, grep can't match | NUL/control byte in regex literal | Use `\uXXXX` escapes; `scripts/check-no-control-bytes.mjs` catches it |
| Cross-package `bun test` fails on `@noble/ed25519` | `crypto.subtle` polluted between tests in same process | Run each package in its own `bun test` invocation (turbo CI already does this) |

### Versioning policy (semver applied to changeset bumps)

We use semver via changesets. Choose the bump type carefully — `linked`
in `.changeset/config.json` propagates the bump to all `@wasmagent/*`
packages, so the wrong choice ripples wide.

| Change | Bump | Example |
|---|---|---|
| Breaking API change, removed export, schema field renamed | **major** | `1.2.0 → 2.0.0` |
| New feature, new public API, new package | **minor** | `1.2.0 → 1.3.0` |
| Bug fix, doc fix, security patch, version-coherence alignment | **patch** | `1.2.0 → 1.2.1` |

**Common mistake**: using `minor` for a coordination-only bump (e.g.,
"align with core-four version"). Use **patch** instead — coordination
isn't a feature.

### Release flow (two-stage PR)

For any package already on npm:

1. Land your change on `main` with `.changeset/<name>.md` describing
   what changed. The pre-push hook ensures CI-equivalent checks ran.
2. `.github/workflows/release.yml` (changesets/action) auto-opens
   `chore: release packages` PR with version bumps + CHANGELOG.
3. Review the diff, merge the PR.
4. Release workflow re-fires, runs `changeset publish` → npm.
5. `changesets/action` also auto-creates per-package GitHub Releases;
   the `Create GitHub Release (aggregate)` step adds a top-level
   `wasmagent v<core-version>` release tied to CHANGELOG.

`linked: [['@wasmagent/*']]` means packages mentioned in a changeset
+ their dependents share the same version number. A changeset listing
5 packages bumps only those 5 — not the entire namespace.

### Transient failures and recovery

- **`Premature close` from GitHub GraphQL** during `changeset version`
  → `gh run rerun <id> --failed`. Not a code bug.
- **`UNSTABLE` PR mergeable state** with "no checks reported" on the
  `changeset-release/main` branch → safe to merge; content was
  already validated by the main-branch CI that produced it.
- **`npm error 404 ... not in this registry`** on an existing package
  → almost always `NPM_TOKEN` scope problem. Granular Tokens have
  *two* permission panels — Packages scope AND Organizations. To
  publish `@wasmagent/<pkg>` (org-owned), the token needs both
  `@wasmagent` scope read+write AND `wasmagent` org read+write. Local
  `npm publish --dry-run` skips the org-write API, so it passes even
  with a half-configured token. Verify at
  `npmjs.com/settings/<user>/tokens/granular-access-tokens/<id>`.

### First-time publish (brand-new package never on npm)

Different path. `changeset publish` fails with E404 because the
package has no manifest yet. Use the `publish-alpha.yml` workflow:

1. Set required `package.json` fields (`publish-check.mjs` validates):
   `homepage`, `repository`, `publishConfig: { access: "public" }`,
   `files`, `license`. `wasmagent.stability` must be one of
   `"stable" | "beta" | "alpha" | "demo" | "research"`.
2. Keep `"private": true` so changesets doesn't try to publish.
3. Add the package to `.changeset/config.json` `ignore` list.
4. Trigger `publish-alpha.yml` (Actions tab → "Publish Alpha Packages",
   set `packages` to the dir name, `dry_run: false`). The workflow
   removes `private:true` for the publish, then leaves the package
   in its original state.
5. After first publish: remove `"private": true` from `package.json`,
   remove from `.changeset/config.json` ignore list, commit. From
   now on use the normal Release flow above.
6. npm CDN takes 2–5 minutes to propagate. E404 right after a
   successful publish (`+ @wasmagent/xxx@0.1.0`) is normal.

### Long-term improvement: Trusted Publisher (OIDC)

Replace long-lived `NPM_TOKEN` with GitHub OIDC. Configure at
`npmjs.com/settings/wasmagent/publishing-access` (org-level) or
per-package, pointing to `WasmAgent/wasmagent-js` +
`.github/workflows/release.yml`. Delete the `Set npm registry` step
and `NPM_TOKEN` env from release.yml; `permissions: id-token: write`
is already in place. Eliminates the entire E404-token-scope class
of failures.
## Repository Boundaries

**This repository owns:**
- runtime (WASM kernels, KernelPool, executor)
- MCP gateway / firewall (`@wasmagent/mcp-gateway`, `@wasmagent/mcp-firewall`)
- AEP emitter and signature (`@wasmagent/aep`)
- Capability manifest and attestation (`@wasmagent/mcp-attestation`)
- Compliance verifier and repair loop (`@wasmagent/compliance`) — produces `ComplianceEvalRecord`
- Core agent framework (`@wasmagent/core`)
- Integrations and adapters (AI SDK, Mastra, OTel exporter)

**Other repositories own — do not duplicate here:**

| Capability | Owner |
|---|---|
| AgentBOM / MCP Posture / Trust Passport specifications | `agent-trust-infra` |
| Enterprise audit reports, regulatory control mapping (OWASP/EU AI Act/NIST) | `open-agent-audit` |
| Training data pipeline (SFT/DPO export) | `trace-pipeline` |
| Dynamic evaluation protocol (FAEP) | `fresharena` |

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
