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

