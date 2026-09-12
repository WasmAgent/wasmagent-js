---
"@wasmagent/aep": minor
---

Hardening from the adversarial test pass:

- `run_attribution_backing_floor` consistency is now enforced at emission: when `run_attribution_backing_observed` is provided, an omitted floor is auto-computed as the weakest observed grade, and an explicit floor that is not the weakest throws — silently keeping a stronger floor would produce exactly the masking the floor exists to prevent.
- Canonical serialization now preserves a literal `"__proto__"` key (via `Object.defineProperty`) instead of silently dropping it through the prototype setter, keeping canonical bytes identical to the Rust verifier's for hostile records.
- New adversarial suite: envelope lifting, wrong-key verification, signature corruption modes, floor-consistency attacks, and the cross-language Rust-gateway fixtures.

Additionally: `authorization_evidence_count` (integer ≥ 0, optional) added as a selective-omission defense — commits the producer to a specific evidence population so an auditor can detect when a weak authorization has been omitted entirely.
