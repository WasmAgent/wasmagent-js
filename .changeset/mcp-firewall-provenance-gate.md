---
"@wasmagent/mcp-firewall": minor
---

feat(mcp-firewall): IF-07a provenance-preserving information-flow gate

- `GatewayRequest.inputProvenance` threads explicit taint provenance
  (`TaintedObservation[]`) from earlier tool results into the next sink
  decision; threading is the only channel — no process-wide taint ledger.
- New gate rules (`src/provenance-policy.ts`): `sink-tainted-provenance-deny`
  (sensitive label `secret`/`credential` headed for a dangerous sink
  `network_send`/`credential_use`/`shell_exec`/`filesystem_write`) and
  `sink-tainted-identity-deny` (argument value SHA-256 matches a
  sensitive-labeled observation's `contentHash` — renamed/moved/nested
  placements still hit). Deny keys on labels + identity, not value shape;
  consent never downgrades them.
- `composeVerdict` treats explicitly labeled observations as `tainted`
  (labels are now load-bearing via `isTainted`).
- `RenderedTaintedObservation` carries `taintLabels` + `contentHash` through
  the prompt-assembly boundary instead of stripping them;
  `gateway.wrapResult` accepts optional `taintLabels` for source minting.
- `GatewayDecision.evidenceRef.inputTaintLabels` is the producer for AEP
  `input_taint_labels` (schema field already existed; no schema change).
- Fixtures: IF-07a flipped from documented limitation to enforced deny
  (threaded base64 secret); IF-07a-2 pins the identity match under
  renamed/nested args; GATE-01..11 pin gate semantics in
  `src/provenance-gate.test.ts`.
