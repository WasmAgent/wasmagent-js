# Release history — agentkit-js

> A lightweight ledger of what shipped, when, and why. The repository
> intentionally has not declared 1.0 yet (see [`docs/strategy/api-stability.md`](api-stability.md)
> for the freeze surface and [`ROADMAP.md`](../../ROADMAP.md) for the
> 2026-12-15 1.0 calendar). Until then, this file is the public record
> of what each 0.x release did and which axes from the strategy memo it
> moved.
>
> **Format**: latest first. Each entry pins the *npm version line on the
> day of the entry* (most prominent package on the left), the change
> headline, the strategy axis (S1 / S1' / S2 / S3 / S4) it serves, and
> the commit range. We deliberately do not promise SemVer guarantees on
> 0.x; the freeze surface is documented separately in
> [`docs/strategy/api-stability.md`](api-stability.md).

## 2026-06-17 — strategy update + Glama 0.2.0 release

| Package | Version |
|---------|---------|
| `@agentkit-js/core` | 0.2.0 |
| `@agentkit-js/mcp-server` | 0.2.0 |
| `@agentkit-js/aisdk` | 0.1.0 (unchanged — codemodeExecutor docstring refresh only) |

**Why this entry exists**

A meaningful strategy delta + the first Glama-published release of
`@agentkit-js/mcp-server`, plus an upstream PR landed at
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
