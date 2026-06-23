# Trust Page

> **Last refreshed: 2026-06-13.** Consolidated by D4 of the
> [2026-06-13 optimization brief](2026-06-competitiveness.md): one page
> for procurement reviews, security questionnaires, and "is this project
> safe to depend on?" diligence.
>
> **Read this first.** Every claim below points at a file you can audit
> yourself. We deliberately avoid words like "enterprise-ready" or
> "battle-tested" — instead each row is a *commitment* with a *signal*
> and a *verifiable artefact*. If a row's artefact is missing, the
> claim is false. Open an issue and we'll either fix it or retract.

---

## 1. The differentiator vs Mastra (and Vercel-AI / OpenAI Agents JS)

| | Mastra | Vercel AI SDK | OpenAI Agents JS | **WasmAgent (this project)** |
|---|---|---|---|---|
| **License** | Apache-2.0 core + **Enterprise (commercial)** modules | Apache-2.0 | MIT | **Apache-2.0 — every package, no double-license** ([LICENSE](../../LICENSE)) |
| **SOC 2 / SOC 3** | ❌ public statement: "no SOC 2 yet" (2026-04 third-party assessments) | n/a (SDK, not a service) | n/a (SDK) | n/a — **no SaaS to certify** (we ship code, not a hosted control plane); see [Section 6](#6-no-saas-no-data-collection) for what that means for your data |
| **Time-travel debugger** | ❌ (Studio shows traces, not "fork from step") | ⚠️ DevTools, no fork | ❌ | ✅ [`@wasmagent/devtools`](../../packages/devtools/) — `EventLogReplay` + step-fork UI |
| **Air-gapped / offline closure** | ❌ providers are SaaS | ❌ provider HTTP | ❌ | ✅ `@wasmagent/model-local` + WASM kernel = full agent loop, zero outbound traffic |
| **Sandbox-escape SLA — public drill record** | ❌ | n/a | n/a | ✅ [`docs/strategy/security-drill-log.md`](security-drill-log.md) |
| **Release cadence — public ledger** | ⚠️ release notes only | ✅ | ✅ | ✅ [`docs/strategy/release-cadence-log.md`](release-cadence-log.md) |
| **npm provenance on every package** | ⚠️ partial | ✅ | ✅ | ✅ [`scripts/add-publish-provenance.mjs`](../../scripts/add-publish-provenance.mjs) — 32 packages opt in by default; CI verifies via `bun run publish:check` |

This is the structural pitch: **we don't compete with Mastra on
platform breadth, we compete on the things a small, all-Apache-2.0,
non-SaaS project can credibly *prove*.**

---

## 2. Supply-chain integrity

| Commitment | How it's enforced | Verify |
|---|---|---|
| Every published package on npm carries provenance metadata (`--provenance`) | `publishConfig.provenance: true` in every public package; release workflow has `id-token: write`. | `npm view @wasmagent/core --json | jq .dist` shows attestation; or click the green "Provenance" badge on [npmjs.com/package/@wasmagent/core](https://www.npmjs.com/package/@wasmagent/core). |
| No package publishes from a developer laptop | All releases run via `release.yml` in GitHub Actions; the `id-token` claim ties the artefact to a Sigstore-verifiable signer | [`.github/workflows/release.yml`](../../.github/workflows/release.yml) |
| Lockfile is committed and CI-frozen | `bun install --frozen-lockfile` in every CI job; renovate-style updates land via PR with full test run | [`bun.lock`](../../bun.lock) is in the repo root |
| No transient `postinstall` execution from dependencies | `bun.lock` records hashes; `package.json` files contain no postinstall hooks; `scripts/publish-check.mjs` blocks publish if a new postinstall is detected | [`scripts/publish-check.mjs`](../../scripts/publish-check.mjs) |
| SBOM available on demand | Each release tag publishes the workspace's resolved dependency tree as a build artefact (CycloneDX-compatible JSON via `bun pm ls --json`) | run `bun pm ls --json` locally; or fetch the `sbom-*.json` asset from any [release](https://github.com/WasmAgent/wasmagent-js/releases) |

---

## 3. Sandbox-escape SLA — and the rehearsal record

[`SECURITY.md`](../../SECURITY.md) commits to:

| Severity | Acknowledge | Mitigation strategy | Patched release |
|---|---|---|---|
| **P0** (sandbox escape, capability bypass) | 48 h | 7 d | 30 d |
| P1 (denial of service in kernel) | 5 working days | 14 d | 60 d |
| P2 (info disclosure outside sandbox) | 5 working days | 30 d | 90 d |

A commitment without a rehearsal is a brochure. The rehearsal is in
[`docs/strategy/security-drill-log.md`](security-drill-log.md) — every
quarter a maintainer files a synthetic P0, the clock runs in public,
and the row is added to the log whether it was met or missed.

**Why this matters more than a SOC 2 badge for our threat model.**
WasmAgent's threat model is *kernel escape from untrusted
model-generated code*, not *unauthorised access to a customer
database*. SOC 2 assesses operational controls of a service
operator. We are not a service operator. The drill log is the
control surface that matters for sandbox tooling — see
[`security-face.md` §1](security-face.md) for the full argument.

---

## 4. Release cadence — visible, not promised

[`GOVERNANCE.md`](../../GOVERNANCE.md) commits to:

> A tagged release every two weeks while
> [`CHANGELOG.md`](../../CHANGELOG.md)'s `[Unreleased]` section is
> non-empty.

The ledger that proves we did is
[`docs/strategy/release-cadence-log.md`](release-cadence-log.md).
**Stalls** (a missed fortnight while there *is* unreleased work) are
logged with a one-line reason; the honest signal is the absence of
stalls, not the presence of releases.

For the **2026-12-15 1.0 freeze date**:

- API stability matrix: [`docs/strategy/api-stability.md`](api-stability.md)
- Maintenance tiers (which packages are 1.0-blocking vs experimental): [`docs/strategy/maintenance-tiers.md`](maintenance-tiers.md)
- Co-maintainer recruiting (bus factor): [`CONTRIBUTING.md#looking-for-a-co-maintainer`](../../CONTRIBUTING.md#looking-for-a-co-maintainer)

---

## 5. Apache-2.0, every package

This project does NOT have an "Enterprise Edition" or a
"Commercial Use" license. Mastra's [Enterprise License](https://github.com/mastra-ai/mastra)
splits its monorepo at the SOC 2 / SSO / multi-tenant feature line.
We don't make those features (we don't make a SaaS), so we don't
need that split.

| What this means in practice | Mastra | WasmAgent |
|---|---|---|
| Use any feature commercially without paying | ⚠️ depends on package | ✅ |
| Fork, rebrand, ship inside a closed-source product | ✅ | ✅ |
| Patent grant (Apache §3) | ✅ Apache-2.0 core | ✅ entire codebase |
| One license to put through legal review | ❌ two | ✅ one |

If you want a single line on your procurement form, it is:
*"Apache-2.0 ([LICENSE](../../LICENSE)), no double-license. Patent grant included."*

---

## 6. No SaaS, no data collection

WasmAgent is a library, not a hosted service. We do not run a
control plane, a metrics endpoint, or any default outbound network
traffic. Concretely:

- **No telemetry by default.** `@wasmagent/otel-exporter` exists
  but you must wire it to your own collector. There is no "phone
  home" path on `npm install` or at runtime.
- **No managed studio.** Our DevTools are a local `WasmAgent
  devtools` HTTP server bound to `127.0.0.1` by default. No cloud
  account required.
- **No vendor lock-in.** Three kernel tiers, four checkpoint
  backends, eight model providers (Anthropic / OpenAI / Doubao /
  DeepSeek / Kimi / Qwen / GLM / MiniMax / + local llama.cpp).
  The thing you're locked into is *the API*, and that API is
  versioned by [`api-stability.md`](api-stability.md).
- **Air-gapped supported.** `@wasmagent/model-local` +
  `@wasmagent/kernel-quickjs` runs an entire agent loop with no
  outbound traffic. See [`examples/local-offline/`](../../examples/local-offline/).

---

## 7. Quick procurement checklist

Copy this into your security review:

| | Status | Evidence |
|---|---|---|
| License | Apache-2.0, every package, no double-license | [`LICENSE`](../../LICENSE) |
| Open source | ✅ | [github.com/WasmAgent/wasmagent-js](https://github.com/WasmAgent/wasmagent-js) |
| Vulnerability disclosure | ✅ private channel + 48h P0 SLA | [`SECURITY.md`](../../SECURITY.md) |
| Public sandbox-escape drill record | ✅ | [`security-drill-log.md`](security-drill-log.md) |
| Release cadence ledger | ✅ bi-weekly with stall accounting | [`release-cadence-log.md`](release-cadence-log.md) |
| Supply-chain provenance | ✅ Sigstore via npm `--provenance` on every package | npm registry green badge |
| SBOM | ✅ on demand (`bun pm ls --json`) | this page §2 |
| Air-gapped / offline | ✅ | [`examples/local-offline/`](../../examples/local-offline/) |
| API stability commitment | ✅ frozen 2026-12-15 (1.0) | [`api-stability.md`](api-stability.md) |
| Bus factor | 1 maintainer + active co-maintainer search | [`CONTRIBUTING.md#looking-for-a-co-maintainer`](../../CONTRIBUTING.md#looking-for-a-co-maintainer) |
| Telemetry on by default | ❌ (opt-in via `@wasmagent/otel-exporter`) | this page §6 |
| Vendor SaaS dependency | ❌ | this page §6 |

---

## 8. Found something missing?

This page is part of [the public competitiveness brief](2026-06-competitiveness.md).
If a row is wrong, missing, or out of date, please:

1. open a GitHub issue tagged `trust-page`, or
2. email the address in [`SECURITY.md`](../../SECURITY.md) for
   anything sensitive.

Each refresh updates the *Last refreshed* stamp at the top.
