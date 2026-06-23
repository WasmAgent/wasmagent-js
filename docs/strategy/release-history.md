# Release history — wasmagent-js

> A lightweight ledger of what shipped, when, and why.

## 2026-06-23 — RLAIF pipeline, security fixes, stable API, 1.0.0

| Package | Version |
|---------|---------|
| `@wasmagent/core` | 1.0.0 |
| All `@wasmagent/*` packages | 1.0.0 |

**What shipped**

- RLAIF pipeline: `RolloutForkRunner`, `RolloutRanker`, `BuildPassesVerifier`, `VisualAssertVerifier`, `ScalarLLMJudgeVerifier`, `KernelPool`, `RolloutMemoryStore`
- `@wasmagent/core/beta` and `@wasmagent/core/experimental` subpath exports
- `ApprovalPolicy`, `ApprovalRule`, `WriteOpKind`, `PolicyPresets`, `applyApprovalPolicy`
- `BuildResult`, `VisualResult` types for bscode adapter
- Stable API snapshot gate (`scripts/check-stable-api.mjs`) in CI
- Bundle size gate (`scripts/check-bundle-budget.mjs`) in CI
- `replace-workspace-deps.mjs`: fixes `workspace:*` leaking into npm tarballs
- Docs: ecosystem overview, data pipeline guide, getting-started steps 6+7
- Claims registry (`docs/claims/claims.yaml`)

**Breaking from 0.2.0**: None at the API level. `workspace:*` deps in published
packages are now correctly replaced with `^1.0.0` version ranges.

---

## 2026-06-17 — strategy update + Glama 0.2.0 release

| Package | Version |
|---------|---------|
| `@wasmagent/core` | 0.2.0 |
| `@wasmagent/mcp-server` | 0.2.0 |
| `@wasmagent/aisdk` | 0.1.0 (unchanged — codemodeExecutor docstring refresh only) |

**Why this entry exists**

A meaningful strategy delta + the first Glama-published release of
`@wasmagent/mcp-server`, plus an upstream PR landed at
[`cloudflare/agents#1771`](https://github.com/cloudflare/agents/issues/1771)
(filed as a community-recipe issue because the repo restricts PR
creation to collaborators).

**What shipped**

- **`fix(mcp-server)`** — `tasks` capability flags must be objects
  per MCP spec, not booleans. The boolean form passed unit tests but
  failed Zod validation in `mcp-proxy` (which Glama wraps with);
  Claude Desktop and Cursor use the same SDK validators, so the
  boolean form would have silently broken those integrations too.
  Fixed in `eeb5454`. Glama published this as the
  `agentkit-mcp-server@0.2.0` release.
- **`feat(evals-runner)`** — added `arm-batch-grammar` ablation arm.
  Single-call full-plan executor with strict `{plan: [{name, input}, ...]}`
  json_schema. Used to falsify our own
  "Pick/Provide loses global plan view" hypothesis in 30 minutes
  (v7f arm-batch 14.4% << arm-f 38.9%). Falsification chain in
  [`docs/reports/arm-batch-grammar-2026-06-17/analysis.md`](../reports/arm-batch-grammar-2026-06-17/analysis.md).
- **`docs(strategy)`** — 2026-06-17 update on top of S1–S4. Five
  industry shifts (CF portal-default code-mode, OpenAI Agents SDK
  native sandbox, Vercel AI SDK 6 `DurableAgent`, MS Agent
  Governance Toolkit, OWASP Agentic Top 10 + Colorado AI Act
  executable date) tightened the differentiation surface. New axis
  S1' (governance + isolation) added. Code-mode itself is now
  table stakes; the moat is portable executor + paired-statistics
  referee + governance/isolation primitive. Full delta:
  [`docs/strategy/2026-06-17-update.md`](2026-06-17-update.md).
- **`docs(security)`** — new
  [`docs/security/capability-manifest-owasp.md`](../security/capability-manifest-owasp.md)
  with field-by-field OWASP Agentic Top 10 mapping + comparison
  with MS Agent Governance Toolkit + EU AI Act / Colorado AI Act /
  ISO 42001 mapping.
- **`chore(lint)`** — biome warnings driven from 22 errors / 131
  warnings to 0 / 0 / 0 across 402 files. Caught and reverted four
  biome `--unsafe` transformations that introduced real bugs.
- **`docs(aisdk)`** — `agentkitCodemodeExecutor` docstring refresh.
  No code change; the implementation has been complete since
  ~06-12 but the docstrings still claimed "TODO part 2/3".

**Strategy axes moved**

- S1' (governance + isolation) — promoted from inline mention to
  documented ★ axis
- S2 (referee) — `evals-runner` README + report directory now
  include a worked example that falsifies our own hypothesis under
  paired McNemar
- S3 (zero-deploy local Studio) — unchanged
- S4 (bscode is funnel) — `IsolationDemoModal` + 4th
  `DifferentiatorBand` hero land in the bscode repo (see
  [`bscode/README.md`](https://github.com/WasmAgent/bscode#what-this-demonstrates))

**Commit range**: `029efaa..febba82` on `main`.

**External signals after this release**

| Signal | Status |
|--------|--------|
| Glama listing | ✅ released as `0.2.0`, profile completion 25% → 58% |
| `cloudflare/agents` PR/issue | ✅ filed as community-recipe issue #1771 |
| `awesome-mcp-servers` PR | ⏳ `#7910` updated with new score, awaiting maintainer review |
| OSS metrics (stars, downloads) | early — too early to read |

We will record the next entry on the next material release or
strategy delta, whichever comes first. We do not write entries for
pure-fix patch releases unless they affect the published API surface.

---

## Earlier releases (pre-2026-06-17)

The repository was created 2026-06-05; the first 12 days were the
ramp-up phase that produced the v0.1.x line of every package and the
2026-06-12 `competitiveness.md` strategy memo. There is no formal
release-by-release ledger for that period — the canonical record is
[`CHANGELOG.md`](../../CHANGELOG.md) (changesets), the
[`docs/strategy/`](.) directory (decision artefacts), and the
commit history.

If you are reading this looking for the first stable surface: see
[`docs/strategy/api-stability.md`](api-stability.md) for what we
*intend* to freeze at 1.0 and which surfaces we explicitly do not
yet guarantee.

---

*Schema for future entries (kept here so the format stays stable)*:

```
## YYYY-MM-DD — one-line headline

| Package | Version |
|---------|---------|

**Why this entry exists**: 1-2 sentences.

**What shipped**: bulleted list, each with a commit hash and the
strategy axis it serves.

**Strategy axes moved**: which of S1 / S1' / S2 / S3 / S4 advanced.

**Commit range**: <from-sha>..<to-sha>.

**External signals after this release**: a small table of any
inbound signals (issues, downloads jump, listing updates, upstream
PR responses).
```
