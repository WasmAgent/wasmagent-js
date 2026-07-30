---
"@wasmagent/aep": minor
---

feat(aep): `EvidenceCompressor` — auditable summaries and cryptographic fingerprints from long evidence chains (Milestone 7, #272).

Adds a stateless `EvidenceCompressor` class to `@wasmagent/aep` that reduces a sequence of `AEPRecord`s into a compact `CompressedChainSummary` enabling efficient storage and fast verification without sacrificing chain integrity:

- **`EvidenceCompressor.compress(records, options?)`** — produces a `CompressedChainSummary` with: a SHA-256 Merkle-like `chainFingerprint` over per-record canonical hashes (order-sensitive; any tamper invalidates it), `firstRecordHash` / `lastRecordHash` anchors for chain linking, aggregated `toolStats` (per-tool call counts, state-changing counts, side-effect and outcome distributions), `decisionStats` (allow/deny/ask_user/dry_run totals), `budgetTotals` (tokens/tools/risk/retries/human-approvals summed), time range (`startedAtMs`/`endedAtMs`), distinct `runIds`, and an optional `label`.
- **`EvidenceCompressor.verifyChainFingerprint(records, expected)`** — static helper to re-derive the fingerprint from records and compare against a stored summary; answers "is this chain intact?" without re-reading every field.
