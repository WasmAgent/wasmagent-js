# MCP Firewall — fail-closed behavior matrix

> GENERATED from `packages/mcp-firewall/evals/fail-closed/fail-closed-matrix.json` — that JSON file is the authority. Regenerate with `node packages/mcp-firewall/evals/fail-closed/render-fail-closed-matrix.mjs`.

- Repository: `WasmAgent/wasmagent-js` at `47ae05f3baca5a198b40b17e310e3d117228fbd8`
- Evidence anchor: `docs/security/mcp-firewall-hardening-checkpoint.md`

**Purpose.** State exactly what happens when a security dependency or context item is unavailable. The claim is NOT 'everything fails closed'; it is that no missing dependency silently becomes ALLOW.

**Critical invariant.** For a security-sensitive call: missing authority/context required by the active policy must never silently become ALLOW.

## Outcome vocabulary

- **deny** — the invocation is refused by policy
- **ask_user** — the invocation is held for explicit human confirmation
- **reject_protocol** — the request is rejected at the protocol layer (JSON-RPC error)
- **quarantine** — the content is boundary-rendered (taint quarantine) rather than passed through
- **degraded-with-evidence** — execution proceeds in a deliberately reduced mode that is named, reported, and profile-visible
- **not-applicable** — the dependency does not exist at this package boundary; the failure mode belongs to another layer
- **throw-loud** — the call raises a loud exception; it can never silently return ALLOW

## Matrix

| id | condition | outcome | behavior | evidence |
| --- | --- | --- | --- | --- |
| FC-01 | identity absent (GatewayRequest.identity missing at runtime) | throw-loud | evaluate() raises TypeError on req.identity.principalHash — a programming-contract violation is loud, never a decision | packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-01 |
| FC-02 | tenant context absent where tenant enforcement is enabled | deny | rule tenant-enforcement-missing-tenant denies; serverId never substitutes for tenant | packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-02; packages/mcp-firewall/src/gateway-hardening.test.ts::TENANT-ADV-01/TENANT-ADV-02 |
| FC-03 | policy bundle missing/unloadable | not-applicable | PolicyBundle is constructed programmatically (no disk/network loader); an empty custom stack is a deliberate caller decision reported as effective profile 'custom' (FC-22) | packages/mcp-policy/src/bundle.ts; packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-03 |
| FC-04 | capability registry absent while a trusted profile declares required capabilities | ask_user | PROFILE-CAP-00 rule fires (profile-capability-registry-unavailable): missing capability evidence never collapses into capability satisfied | packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-04; packages/mcp-firewall/src/gateway-hardening.test.ts::PROFILE-CAP-00 |
| FC-05 | tool security profile unknown (no registered profile) | ask_user | unknown-profile fail-safe escalates unknown_effect; unprofiled read-named tools on unverified servers escalate (C3, unprofiledToolPolicy ask_user default; deny in strict mode) | packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-05; packages/mcp-firewall/src/gateway-hardening.test.ts::PROFILE-ADV-01/02c |
| FC-06 | approval/consent missing for a state-changing call that would otherwise ask | ask_user | no consent on file → the ask_user decision persists; consent only ever downgrades ask_user→allow, never deny | packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-06; packages/mcp-firewall/src/policy.ts (evaluatePolicy consent downgrade) |
| FC-07 | approval expired (consent expiresAt in the past) | ask_user | lookupConsent filters expired records; the ask_user decision persists at the gateway | packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-07; packages/mcp-firewall/src/consent-hardening.test.ts::CONSENT-ADV-13 |
| FC-08 | approval bound to stale descriptor (consent/toolSnapshotHash mismatch) | ask_user | consent is only honoured when the snapshot hash matches the current descriptor | packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-08; packages/mcp-firewall/src/gateway-consent.test.ts::GW-CONSENT-06 |
| FC-09 | descriptor changed after snapshot (profile rug-pull) | ask_user | computeToolSnapshotHash changes → trusted profile no longer resolves → unknown-profile fail-safe applies | packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-09; packages/mcp-firewall/src/gateway-hardening.test.ts::PROFILE-ADV-05/06 |
| FC-10 | malformed tool args (null where an object is required) | throw-loud | structural classifiers raise TypeError on null args — loud, never silently classified | packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-10 |
| FC-11 | malformed tool args (non-object scalar) | ask_user | scalar args produce no structural signals; an unprofiled tool on an unverified server still escalates via C3 (string 'evil' → ask_user, not allow) | packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-11 |
| FC-12 | malformed JSON-RPC (unparseable / invalid envelope) | reject_protocol | -32700 parse error (id null) for unparseable JSON; -32600 for invalid envelopes | packages/mcp-server/src/stdio.test.ts (-32700); packages/mcp-server/src/McpAgentServer.test.ts (invalid-request); packages/mcp-server/src/protocol-conformance.test.ts::PROTO-ENV-01 |
| FC-13 | unsupported protocol revision requested | not-applicable | no version gate exists: the server always declares 2025-11-25 and tolerates older strings by design; it never rejects on version mismatch | packages/mcp-server/src/protocol-conformance.test.ts::PROTO-INIT-01; evals/protocol/mcp-protocol-matrix.json::M-NEGOTIATION |
| FC-14 | unknown tool | ask_user | gateway: unrecognized tool classifies unknown_effect → fail-safe ask_user; server: tools/call for an unregistered name → -32011 | packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-14; packages/mcp-server/src/McpAgentServer.test.ts (ERR_TOOL_NOT_FOUND) |
| FC-15 | policy engine exception (a rule throws during evaluation) | throw-loud | evaluatePolicy does not catch rule exceptions; the throw propagates to the caller — an exception inside the policy engine can never be read as ALLOW | packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-15 |
| FC-16 | evidence / AEP emission failure | not-applicable | the firewall does not side-effect-emit evidence; GatewayDecision.evidenceRef is a returned data structure produced deterministically from the decision. Downstream emission (mcp-gateway AuditLogger, middleware, AEP records) is consumer-owned. | packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-16; packages/mcp-gateway/src/audit.ts |
| FC-17 | audit sink failure (logger throws) | throw-loud | a throwing AuditLogger/middleware propagates the exception to the caller's pipeline — audit failures are loud; composeMiddleware additionally makes double-next() a loud error to prevent double-emitted audit entries | packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-17; packages/mcp-gateway/src/middleware.ts |
| FC-18 | runtime/sandbox unavailable where a rule depends on runtime enforcement | not-applicable | no rule in @wasmagent/mcp-firewall depends on a runtime sandbox; physical enforcement is the kernel/sandbox boundary (see threat model out-of-scope) | docs/security/mcp-firewall-threat-model.md; docs/security/mcp-firewall-security-model.md |
| FC-19 | DNS / post-resolution enforcement unavailable for a network-sensitive action | not-applicable | SSRF_LOCALHOST_RULE is lexical value classification at decision time; it makes no DNS resolution and has no post-resolution dependency | packages/mcp-firewall/src/sink-policy.ts::SSRF_LOCALHOST_RULE; packages/mcp-firewall/src/resource-adversarial.test.ts |
| FC-20 | canonical-path/symlink enforcement unavailable for a path-sensitive action | not-applicable | classifyResourcePath is lexical; canonical-path and symlink resolution are not attempted, so they cannot silently fail | packages/mcp-firewall/src/resource-path.ts; packages/mcp-firewall/src/resource-adversarial.test.ts::PATH-ADV |
| FC-21 | transport disconnect during a state-changing call | not-applicable | the gateway decision is synchronous and pre-effect; a disconnect does not roll back an allowed call and does not revoke a decision. Effects complete under the authority that was granted at decision time; evidenceRef retains the decision record for audit. | packages/mcp-firewall/src/gateway.ts (evaluate is transport-free); packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-21 |
| FC-22 | explicit custom/empty rule stack (caller replaces the hardened default) | degraded-with-evidence | the caller's stack has full responsibility; an empty stack allows flows the hardened stack would contain. This allow path is DELIBERATE and NAMED: evidenceRef.securityProfile reports 'custom' (never 'hardened'), WIRE-06 documents caller responsibility, and legacy/custom stacks are excluded from F2 containment claims. | packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-22; packages/mcp-firewall/src/gateway-hardening.test.ts::WIRE-06/WIRE-06B |

## Row notes

- **FC-01**: RequestIdentity is a required field; absence is a caller bug surfaced as an exception.
- **FC-02**: P0-04: a server is not a tenant.
- **FC-03**: No load path exists that can fail half-loaded; the default gateway stack is built in-code.
- **FC-04**: Final-audit round 3 fail-closed branch.
- **FC-05**: Operator-verified servers keep the read heuristic — that trust anchor is explicit and named.
- **FC-09**: Descriptor snapshot/rug-pull detection is also implemented server-side (packages/mcp-server/src/toolDescriptorSnapshot.ts).
- **FC-10**: args: Record<string, unknown> is a required object; null is a caller contract violation.
- **FC-12**: Transport-layer rejection; the firewall is a pre-wire library (see FI rows in the protocol matrix).
- **FC-13**: This is a documented interoperability stance, not a fail-closed claim.
- **FC-15**: Verified by construction: evaluate() has no try/catch around the rule loop.
- **FC-16**: Per the evidence rule: if a deployment makes evidence policy-required, enforcement of that requirement lives in the consumer's pipeline (middleware), not in this package. No path in this package turns emission failure into a silent ALLOW.
- **FC-18**: Claim ceiling: the firewall governs 'should this execution be allowed', not 'can this process physically do X'.
- **FC-19**: Post-resolution/DNS-rebinding enforcement belongs to runtime network enforcement, outside this package.
- **FC-20**: Canonical-path/symlink enforcement belongs to the runtime/sandbox layer.
- **FC-21**: Honest boundary: no distributed-transaction rollback exists; do not claim 'disconnect aborts effects'.
- **FC-22**: This is the matrix's 'allow under degraded conditions' case: deliberate, named, machine-visible in evidenceRef.

## Invariants

- **FC-INV-01** — No row whose condition is a missing security dependency yields decision allow on the default hardened path. (evidence: `packages/mcp-firewall/src/fail-closed-matrix.test.ts::FC-INV-01`)
- **FC-INV-02** — Rows with outcome not-applicable state the layer that owns the failure mode; none converts a boundary failure of another layer into a firewall claim. (evidence: `docs/security/mcp-firewall-fail-closed.md`)

