# MCP Firewall Hardening Checkpoint (A0 evidence freeze)

**Purpose:** identity anchor for the hardening workstream. Every later claim
(protocol matrix, fail-closed matrix, conformance report) refers to the commit
and artifact hashes recorded here. This file is inventory-only: the F2 baseline,
corpora, and frozen reports listed below are **not modified** by the hardening
workstream.

- **Repository:** `WasmAgent/wasmagent-js`
- **Recorded at (UTC):** 2026-10-01
- **Tested commit:** `c1a573fc8f49f0f2162a17ddca199bb61fcdd94d` (branch `main`, clean tree)
- **@wasmagent/mcp-firewall version:** 2.2.1
- **package-metadata.json:** `phase: "F2"`, `adversarial_evaluation: "f2_gates_passed"`, `maturity: "beta"`, `security_posture: "defence-in-depth"`, `public_api: "stable-with-minor-change-risk"`
- **Adversarial status per metadata:** F2 gate closed (3rd closure round incl. PROFILE-CAP-00 fail-closed branch); text-mutation escapes 0/242; structural-mutation escapes 0/102; combined cross-product 0/24,684 through the default hardened `MCPGateway`; `redteam_run=false`; `external_evaluation=not_run`.

## Frozen artifact SHA-256 (at the commit above)

| Artifact | SHA-256 |
| --- | --- |
| `packages/mcp-firewall/evals/baseline/mcp-firewall-baseline-v1.json` | `e5b63d71bdc80e0a3e3ef33b10b272c859e483ff6567edd630f71c00d80dd138` |
| `packages/mcp-firewall/evals/corpus/train.jsonl` (38 samples) | `4b352ba01768eca59c0cc438e4bf3ef3b84cdc00d15660f9c657285668afd276` |
| `packages/mcp-firewall/evals/corpus/dev.jsonl` (11 samples) | `e14c1949f6594ef077aebb49d933802e9bfdfcf5a13f0c6437b0b8f056ff1e97` |
| `packages/mcp-firewall/evals/corpus/holdout.jsonl` (11 samples) | `7078a4c89595eed3e6c36fc415440aeb3af6fbab2faca0c4eef774abc1ea4060` |
| `packages/mcp-firewall/evals/corpus/redteam.jsonl` (empty, reserved) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `packages/mcp-firewall/evals/corpus/external.jsonl` (empty, reserved) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `packages/mcp-firewall/evals/mutations/mutators.ts` (22 text mutators) | `bad35b095f15e7522634cb03277346f5c89ee9fcff77f7f604c273038833ca96` |
| `packages/mcp-firewall/evals/mutations/structural.ts` (structural mutators + scenarios) | `abccd8f878411219977315fe84019f157afbf67c34d929f611c3ae2eb4bb22f8` |
| `packages/mcp-firewall/evals/mutations/index.ts` | `6231ef9dfbcbf5746be353ae399d916409e5f1d59104e3878f74385edb678186` |
| `packages/mcp-firewall/evals/report/adversarial-report.mjs` (builder + `validatePromotionState`) | `d2eda0949469514696fa516bb68fc9c0351daa83a3f1562f4e5b1f80dec7d87a` |
| `packages/mcp-firewall/evals/report/generate-adversarial-report.mjs` | `e9c506f292f30909e48d547e00fed907f9645596e638fbf15cd2670406015c97` |
| `docs/security/mcp-firewall-threat-model.md` | `6f15f0a77667519613dfb26210e736dc032d65eb18b064f9752a7a04fc2cea9e` |
| `docs/security/mcp-firewall-security-model.md` | `13b746590f8eb47f53c987d63e7d5218b3e09c7610de19b45d62c9b4487aadb4` |
| `packages/mcp-firewall/package-metadata.json` | `8b6ad257dd1d7d14db3c385a54e48a92484723c150f46a010181b02cb6a78ad6` |
| `packages/mcp-firewall/package.json` | `f42f860c21f279e0042a3b970698825ea7b0a426f1fa3ad75122330facf2ea0e` |

Generated (not frozen — rewritten by the F5 gate test on every run):
`packages/mcp-firewall/evals/results/structural-escape-metrics.json`
(`wasmagent-mcp-firewall-escape-metrics/v1`, all three escape rates 0 at this commit).

## Test & CI surface that exercises firewall/gateway security

- Test runner: `bun test` (Bun 1.3.14). Baseline at the commit above:
  `bun test packages/mcp-firewall` → **381 pass / 1 todo / 0 fail** (24 files, 3962 expect calls).
- Full monorepo: `bun run turbo run test --filter=!@wasmagent/kernel-pyodide`.
- CI: `.github/workflows/mcp-firewall-adversarial.yml` jobs F0 (corpus integrity),
  F1 (baseline regression + maturity), F2 (mutation suite), F3 (holdout split 38/11/11),
  F4 (structural policy: sink + capability), F5 (containment e2e incl. structural escape
  gate), F6 (adversarial report generation + promotion-state validation + artifact-SHA==HEAD).
  `ci.yml` additionally runs MCPTox security benchmark (non-blocking) and the
  `aep-corpus` job against `WasmAgent/wasmagent-protocol@main`.

## Known limitations, exactly as stated upstream

- Security model (`mcp-firewall-security-model.md`): "The firewall does not
  guarantee detection of all malicious natural-language payloads." /
  "Semantic detection is defence-in-depth, not the root of trust." Flagship
  invariant: detector bypass does **not** imply an unsafe effect (A1–A4 bypass
  taxonomy; only `containment: "escaped"` is a boundary failure, P0 disclosure).
- Threat model (`mcp-firewall-threat-model.md`) out-of-scope: kernel escape from
  `@wasmagent/kernel-*`, Cloudflare infrastructure compromise, side-channel
  timing attacks against hashing.
- `package-metadata.json`: `redteam_run=false`, `external_evaluation=not_run`;
  F2 zero-escape claims apply only to the frozen declared corpus/mutator set.
- Perf: `evals/results/perf-measurements.json` is informational; no regression
  budget frozen.
- `docs/15-milestones.md` marks runtime-conformance (protocol-level) unchecked;
  no protocol-support matrix or consolidated fail-closed matrix existed at this
  commit — that absence is what the hardening workstream addresses.

## Inventory rule

Nothing in this workstream alters the F2 baseline (`mcp-firewall-baseline-v1.json`),
the corpora splits, the mutator sources, or past frozen results. New workstreams
(protocol matrix, fail-closed matrix, information-flow/commit-time fixtures,
conformance report) are additive and evidence-linked to this commit.
