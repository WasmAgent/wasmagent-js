# RFC: IF-07a provenance-preserving information-flow gate

## Problem

`@wasmagent/mcp-firewall` could mint taint labels (`taintObservation`) and
propagate them across transformations (`propagateTaint`), but the propagated
labels were **inert at every decision point**:

- `composeVerdict` derived the `taint` verdict only from content heuristics
  (`instructionLikeTextDetected` / `adversarialScore`) and ignored
  `taintLabels`;
- `GatewayRequest` carried no provenance, so a sink decision could not see
  where its input values came from;
- every sink rule re-identified values by **shape** (arg-key regexes,
  `SECRET_VALUE_RE`, `sensitiveArgPaths`) — which a trivial base64 transform
  defeats.

The measured consequence was fixture IF-07a
(`packages/mcp-firewall/src/information-flow.test.ts`): a secret read from a
tool result, base64-encoded, and placed under a renamed argument reached a
`network_send` sink with decision `allow`. It was recorded — honestly — as a
documented limitation: "value-transform defeats value-shape detection;
automatic taint-through-transformation is NOT claimed."

At the same time the AEP evidence schema already declared
`input_taint_labels` / `deny_reason_class: "tainted-input"` — with **no
producer anywhere**, so even the "explicit taint label exists" claim was
unobservable in emitted records.

## Proposed shape

An explicit, caller-threaded provenance gate. No process-wide taint ledger is
introduced (the documented FI-TAINT-PROPAGATION posture is unchanged).

1. **Channel** — `GatewayRequest.inputProvenance?: TaintedObservation[]`.
   Threading a set is the caller's declaration that this call consumes data
   derived from those observations.
2. **Gate** — `makeTaintProvenanceRules({ provenance, sinks })`
   (`src/provenance-policy.ts`) appends two rules to the per-request stack:
   - `sink-tainted-provenance-deny` — a threaded observation carries a
     sensitive label (`secret`, `credential`) and the target sink is
     dangerous (`network_send`, `credential_use`, `shell_exec`,
     `filesystem_write`) → `deny`;
   - `sink-tainted-identity-deny` — a string argument value's SHA-256 equals
     the `contentHash` of a sensitive-labeled threaded observation → `deny`.
     `propagateTaint` hashes the derived content, so the encoded form matches
     at any argument name and any nesting depth.
   Deny keys on labels and value identity — never on value shape. Denies are
   never downgraded by consent (existing `evaluatePolicy` contract).
3. **Sinks** — profile-authoritative when a trusted profile exists
   (final-audit C4); otherwise the full descriptor
   (`classifyToolSinks(name + description)`), matching
   `makeSinkAwarePolicyRule`.
4. **Verdict** — `composeVerdict` now uses `isTainted(obs)`: explicit labels
   make an observation `tainted` even when text heuristics miss. The policy
   verdict remains the only binding decision.
5. **Boundary fix** — `RenderedTaintedObservation` now carries `taintLabels`
   and `contentHash` instead of stripping them at the prompt-assembly
   boundary; `gateway.wrapResult` accepts optional `taintLabels` so sources
   can mint labels.
6. **Evidence** — `GatewayDecision.evidenceRef.inputTaintLabels` (union of
   threaded labels) is the producer for AEP `input_taint_labels`; a
   provenance deny lands in `matchedPolicyIds` and maps to
   `deny_reason_class: "tainted-input"` in downstream AEP records. No AEP
   schema change — the fields already exist.

Fixtures: IF-07a flips to `deny` (provenance threaded), new IF-07a-2 pins the
identity match under renamed/nested args, and GATE-01..11
(`src/provenance-gate.test.ts`) pin the matrix, the no-provenance boundary,
and zero false positives for benign labels.

## Why-not (alternatives rejected)

- **Process-wide content-hash taint ledger** — auto-detecting values without
  threading contradicts the documented design ("no automatic process-wide
  taint ledger", FI-TAINT-PROPAGATION), adds lifecycle/eviction and
  false-positive problems, and would need its own RFC. Revisit only with a
  concrete lifecycle design.
- **Value-scanning DLP over tool results** — a different (semantic) layer
  with a different failure model; FI-RESPONSE-DLP stays `not-implemented`
  and taint gating must not be presented as DLP.
- **Trust-level default minting** (every untrusted result auto-labeled
  `tool_supplied`) — churns every existing evidence/matrix row and does not
  by itself gate anything (normal agent traffic is tool-supplied). Deferred;
  label minting stays explicit until a concrete consumer demands defaults.
- **Extending `evaluatePolicy`'s signature** — unnecessary; per-request rule
  factories close over the provenance, keeping the policy engine generic.
