# @wasmagent/mcp-firewall — Vulnerability Reporting Guide

> **Do not file public issues for exploitable vulnerabilities.** Use the private
> channel described below.

---

## How to report

Report privately to the repository owner (see `SECURITY.md` for the primary
disclosure contact). Do not open a public GitHub issue until a fix is in place.

Do not disclose active zero-days — payloads or techniques with no deployed
mitigation — before a fix is available. Coordinated disclosure protects downstream
users who may not yet have patched.

---

## Report format

Include all of the following in your private report. Incomplete reports may delay
triage.

| Field | Description |
|-------|-------------|
| **payload** | The exact text, bytes, or structured value used (tool name, description, inputSchema, or return value) |
| **tool descriptor** | The full `McpToolEntry` object (name, description, inputSchema) used in the reproduction |
| **runtime args** | The argument object passed to `evaluatePolicy` or `MCPGateway.evaluate` |
| **expected unsafe effect** | What the attack would achieve if the firewall were absent (e.g. "exfiltrate ~/.ssh/id_rsa to attacker.example") |
| **observed effect** | What actually happened with the firewall active — whether it was denied, asked_user, warned, or allowed |
| **firewall version** | The exact `@wasmagent/mcp-firewall` version from `package.json` |
| **minimal reproduction** | A self-contained TypeScript snippet (or test file) that reproduces the behavior using only `@wasmagent/mcp-firewall` public APIs |

---

## Issue labels

When a fix PR is opened, use the appropriate label to classify the bypass:

| Label | Meaning |
|-------|---------|
| `mcp-firewall:detector_bypass` | Semantic detector (keyword bag or n-gram) missed the payload; deterministic boundaries may still have blocked the effect (A1 bypass) |
| `mcp-firewall:policy_bypass` | Policy engine allowed the call despite a vetted threat signal (A2 boundary) |
| `mcp-firewall:containment_bypass` | Taint or consent boundary failed to contain an effect that detection and policy missed (A3 boundary) |
| `mcp-firewall:consent_bypass` | Consent ledger or argument scope binding failed to require authorisation for a state-changing call |
| `mcp-firewall:rug_pull_bypass` | Descriptor swap was not detected, or prior consent was not invalidated on descriptor change |

A single report may carry more than one label if multiple layers failed.

---

## Severity classification

| Bypass class | Description | P-level |
|-------------|-------------|---------|
| **A1 — detector miss** | Keyword/n-gram detection missed; at least one deterministic boundary still blocked the unsafe effect | P2 — detector quality improvement |
| **A2 — policy miss** | Detection and policy both missed; taint or consent boundary blocked | P1 — policy correctness issue |
| **A3 — containment miss** | Detection, policy, and taint/consent all missed; runtime sandbox boundary blocked | P1 — serious, partial defence-in-depth collapse |
| **A4 — full bypass** | All layers bypassed; unsafe effect escaped to execution | P0 — critical security boundary failure |

---

## Disclosure SLA

The SLA from `SECURITY.md` applies to `@wasmagent/mcp-firewall` reports:

- **P0 (A4 bypass):** acknowledgement within 48 hours, mitigation strategy
  within 7 days, patched release within 30 days. Affected users notified via
  GitHub Security Advisory.
- **P1:** best-effort timelines tracked on the issue.
- **P2 (A1 detector bypass):** incorporated into the next detector update cycle;
  the payload may be added to the holdout or mutation suite.

Reporters are credited in the advisory unless they request otherwise.

---

## What to expect from A1 reports

If your report demonstrates that the keyword bag or n-gram classifier missed a
payload — but the policy engine, sink guards, capability registry, taint boundary,
or consent ledger still blocked the unsafe effect — the report is valued as a
**detector quality improvement**, not a critical security boundary failure.

This is by design: semantic detection is defence-in-depth, not the root of trust.
The payload will be reviewed for inclusion in the next detection update, and the
bypass will be classified as A1. You will be credited.

---

*See also:*
- *[Security model and flagship invariant](./mcp-firewall-security-model.md)*
- *[Threat model and category table](./mcp-firewall-threat-model.md)*
- *[Attack demos and OWASP coverage](./mcp-firewall-attack-demos.md)*
