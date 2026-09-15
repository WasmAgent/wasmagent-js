# @wasmagent/mcp-firewall — Security Model

> **Audience:** security engineers, red-teamers, and application architects integrating
> `@wasmagent/mcp-firewall` into a production MCP deployment.

---

## Guarantee

The firewall does not guarantee detection of all malicious natural-language payloads.

Security-critical effects are expected to be constrained by deterministic policy,
capability, consent, taint, and runtime boundaries.

Semantic detection is defence-in-depth, not the root of trust.

---

## Flagship invariant

**Detector bypass DOES NOT imply unsafe effect.**

A payload that evades keyword and n-gram detection (A1 bypass, see bypass
classification below) still faces the policy engine, capability registry, taint
boundary, and consent ledger. All four must also fail before an unsafe effect can
escape.

This property is expressed in the `FirewallSecurityVerdict` type
([`src/verdict.ts`](../../packages/mcp-firewall/src/verdict.ts)):

```ts
// detection=missed, policy=deny, containment=contained:
// semantic bypass attempted — policy layer caught what detection missed.
{ detection: "missed", policy: "deny", containment: "contained", final: "deny" }
```

The `containment` field is set to `"contained"` when detection missed but a
downstream layer blocked execution. `containment: "escaped"` (A4) is the only
outcome that represents a true security boundary failure.

---

## Defense-in-depth architecture

Every MCP tool call traverses the following chain before execution:

```
untrusted MCP metadata / arguments / outputs
                ↓
         normalization
         (Unicode normalisation, homoglyph folding,
          invisible-char stripping, encoding decode)
                ↓
    semantic detection signals
    (keyword bag — stage 1, n-gram classifier — stage 2)
                ↓
     structured policy engine
     (DEFAULT_RULES, DENY_BLOCKED_RULE, ASK_HIGH_RISK_RULE,
      FULL_DEFAULT_RULES, makeSinkAwarePolicyRule)
                ↓
capability + tenant + consent checks
(CapabilityRegistry, CapabilityEnvelope, makeTenantIsolationRule,
 InMemoryConsentLedger, argument scope binding)
                ↓
          taint boundary
          (taintObservation, label propagation,
           renderTaintedObservation)
                ↓
       sandbox/runtime effect
       (tool call, network, filesystem, shell)
                ↓
     machine-readable evidence
     (FirewallSecurityVerdict, AEP record)
```

Each layer operates deterministically with no model inference and no network calls.
A layer's failure (detector miss, policy misconfiguration) does not disable the
layers below it.

---

## The seven enforcement layers (F1)

| # | Layer | Module | What it enforces |
|---|-------|--------|-----------------|
| 1 | **Snapshot + rug-pull detection** | `vetting.ts` (`snapshotTool`, `detectRugPull`, `hashContent`) | Descriptor integrity — detects descriptor swaps after initial registration |
| 2 | **Static vetting + normalization pipeline** | `vetting.ts` (`vetTool`, `evaluateAdversarial`) | Injection strings, exfiltration keywords, invisible chars, sampling-abuse patterns; normalization decodes homoglyphs, URL-encoding, hex-escape, base64 fragments before detection |
| 3 | **Per-call policy** | `policy.ts` (`evaluatePolicy`, `DEFAULT_RULES`, `DENY_BLOCKED_RULE`, `ASK_HIGH_RISK_RULE`) | Blocks or escalates calls based on vetting outcome and call-level context |
| 4 | **Structural sink/capability guards** | `sink-policy.ts` (`SINK_POLICY_RULES`, `FULL_DEFAULT_RULES`, `makeSinkAwarePolicyRule`), `capability.ts` (`makeCapabilityPolicyRule`, `makeTenantIsolationRule`) | Deterministic sink classification (shell exec, network send, filesystem write, credential use); capability registry; cross-tenant isolation — all without semantic detection |
| 5 | **Taint tracking + label propagation** | `taint.ts` (`taintObservation`, `renderTaintedObservation`) | Tags tool outputs with trust level; propagates taint labels to prevent raw external content from re-entering the prompt as trusted instructions |
| 6 | **Consent ledger + argument scope binding** | `consent.ts` (`InMemoryConsentLedger`, `hashUiText`) | Ensures prior consent is invalidated on descriptor change (rug-pull); binds approval to the exact argument scope the user saw |
| 7 | **Layered verdict** | `verdict.ts` (`composeVerdict`, `FirewallSecurityVerdict`) | Aggregates outputs of all layers into a machine-readable verdict; produces the `containment` field that proves bypass did not imply unsafe effect |

The `MCPGateway` class ([`src/gateway.ts`](../../packages/mcp-firewall/src/gateway.ts))
composes all seven layers into a single stateful object.

---

## Security taxonomy — attack category to layer mapping

The table below maps each recognised attack category to the detection signal,
policy rule, and runtime boundary that constrains it. Refer to
[`mcp-firewall-threat-model.md`](./mcp-firewall-threat-model.md) for the full
category table with expected default effects.

| Category | Primary semantic signal | Deterministic boundary |
|----------|------------------------|----------------------|
| `instruction_override` | keyword bag + n-gram stage 1/2 | policy deny (DENY_BLOCKED_RULE) |
| `exfiltration` | exfiltration keyword bag | SECRET_NETWORK_SINK_RULE (deny) / ASK_HIGH_RISK_RULE (ask_user) |
| `credential_access` | credential keyword bag | CREDENTIAL_PATH_RULE (deny), capability guard (deny) |
| `command_execution` | keyword bag, n-gram | SHELL_EXEC_CAPABILITY_RULE (ask_user), capability guard (deny without exec.shell grant) |
| `ssrf` | URL/host pattern | SSRF_LOCALHOST_RULE (deny) |
| `filesystem_escape` | path pattern in args | CREDENTIAL_PATH_RULE, capability guard |
| `scope_escalation` | privilege-escalation keyword | capability guard (deny without grant) |
| `cross_tenant_access` | tenant-segment pattern in args | makeTenantIsolationRule (deny) |
| `tool_shadowing` | name-squatting pattern | static vetting (warn/deny) |
| `rug_pull` | descriptor hash mismatch | snapshotTool / detectRugPull (deny); consent invalidated |
| `sampling_abuse` | privilege-escalation claim in sampling system prompt | vetting (blocked), policy (deny) |
| `supply_chain` | best-effort provenance check | operatorVerified flag on ServerCard |
| `consent_bypass` | not_applicable | consent ledger + argument scope binding |
| `tainted_output_reentry` | adversarialScore > 0.5, instructionLikeTextDetected | taint boundary (quarantine / boundary tag) |

---

## Bypass classification

| Class | Description | Verdict shape | Severity |
|-------|-------------|---------------|----------|
| **A1** | Semantic detector bypassed; policy/runtime boundary blocks the unsafe effect | `detection=missed, containment=contained` | Detector quality improvement; not a critical boundary failure |
| **A2** | Detector AND policy engine bypassed; taint/consent boundary blocks | `detection=missed, policy=allow, containment=contained` (taint held) | Significant; policy misconfiguration review required |
| **A3** | Detector, policy, taint bypassed; runtime sandbox/capability boundary blocks | Effect contained at kernel layer outside this module | Serious; defence-in-depth partially collapsed |
| **A4** | All layers bypassed; unsafe effect escapes | `detection=missed, policy=allow, containment=escaped` | Critical (P0) — true security boundary failure |

Reports demonstrating A4 bypass are treated as P0 under the disclosure SLA.
Reports demonstrating A1 bypass are valued as detector quality improvements
(see [`mcp-firewall-reporting.md`](./mcp-firewall-reporting.md)).

---

## Known limitations

1. **First-line semantic detection.** The keyword bag (stage 1) and n-gram logistic
   regression (stage 2) are lightweight filters tuned for known adversarial patterns.
   They are not adversarial-grade ML classifiers. A novel, well-crafted payload with
   no overlap with known keyword or n-gram features may receive `detection=missed`.
   The policy, capability, consent, and taint boundaries remain active regardless of
   detector outcome.

2. **Adaptive attackers.** An adversary who knows the implementation and current
   thresholds can construct payloads targeting the detection gap. The flagship
   invariant holds as long as the deterministic layers (policy, sink guards, capability,
   consent, taint) are correctly configured. Misconfiguring these layers is the
   primary attack surface against adaptive adversaries.

3. **No kernel escape guarantee.** `@wasmagent/mcp-firewall` operates at the MCP
   tool-call layer. It does not provide WASM/process isolation. Kernel escape
   guarantees are the responsibility of `@wasmagent/kernel-*` packages and the host
   runtime. See `SECURITY.md` for the kernel escape P0 SLA.

4. **Heuristic sink and source classification.** `classifyToolSinks` and
   `classifyArgSource` use name-pattern heuristics, not static analysis or
   type annotations. A tool with an unusual name that matches no pattern may be
   classified as `unknown` sink and skip sink-aware rules. The operator should
   use `makeSinkAwarePolicyRule` with the full tool descriptor to improve
   classification accuracy.

5. **Consent scope binding is in-memory.** `InMemoryConsentLedger` does not
   persist across process restarts. An application restart clears all recorded
   consents, requiring re-authorisation for subsequent state-changing calls. This
   is the safe default; persistence is a consumer responsibility.

---

## Evidence trail

Every evaluated call produces a `FirewallSecurityVerdict`
([`src/verdict.ts`](../../packages/mcp-firewall/src/verdict.ts)) with five fields:
`detection`, `policy`, `containment`, `consent`, `taint`, plus the binding `final`
decision. Downstream audit systems (AEP emitter, compliance verifier) consume this
verdict to generate signed evidence records that prove the enforcement chain ran.

---

*For attack demos, see [`mcp-firewall-attack-demos.md`](./mcp-firewall-attack-demos.md).*
*For the threat model, see [`mcp-firewall-threat-model.md`](./mcp-firewall-threat-model.md).*
*For reporting vulnerabilities, see [`mcp-firewall-reporting.md`](./mcp-firewall-reporting.md).*
