# @wasmagent/mcp-firewall — Threat Model

> **Audience:** security engineers scoping a red-team engagement, operators sizing
> their deployment threat model, and contributors evaluating whether a bypass
> report is in-scope.

---

## Adversary capabilities (in-scope)

The threat model assumes an adversary who:

- Controls the tool name, description, and input schema of one or more MCP tools
  (e.g. operates a malicious or compromised MCP server)
- Controls the output (return value) of those tools
- Can observe and influence MCP server behavior over multiple sessions
- Knows the firewall implementation, including source code and detection weights
- Knows current detection thresholds and keyword lists
- Can craft payloads in any language (English, Chinese, Russian, etc.)
- Can obfuscate payloads using: base64 encoding, URL-encoding, hex-escape,
  Unicode full-width homoglyphs, zero-width characters, or other encoding schemes
- Can fragment a payload across multiple tool fields (name, description, inputSchema)
- Can retry adaptively — observing block reasons and adjusting subsequent payloads
- May know the previous rejection reason from structured error responses

---

## Out of scope

The following are explicitly outside the threat model for `@wasmagent/mcp-firewall`:

| Scenario | Why out of scope |
|----------|-----------------|
| Kernel escape from `@wasmagent/kernel-*` | WASM/process isolation is owned by kernel packages; see `SECURITY.md` kernel escape P0 SLA |
| Cloudflare infrastructure compromise | Platform-level; outside the library boundary |
| Host OS compromise or root credential theft | The library runs inside an already-compromised process — no library primitive survives this |
| Cryptographic primitive breaks (SHA-256, Ed25519) | Standard assumption; not a library responsibility |
| Consumer misconfiguration (over-granted capability, disabled consent ledger) | Deployment policy; library ships safe defaults |
| Side-channel timing attacks against hashing | Out of scope per SECURITY.md |

---

## In-scope attack categories

| Category | Description | Semantic signal | Policy rule | Runtime boundary | Default effect |
|----------|-------------|----------------|-------------|-----------------|----------------|
| `instruction_override` | Payload in tool descriptor overrides agent instructions | keyword bag + n-gram (best_effort) | DENY_BLOCKED_RULE | policy deny | deny |
| `exfiltration` | Tool descriptor or args route sensitive data to external endpoint | exfiltration keyword bag (best_effort) | ASK_HIGH_RISK_RULE / SECRET_NETWORK_SINK_RULE | policy deny/ask_user | ask_user or deny |
| `credential_access` | Args reference SSH keys, AWS credentials, /etc/shadow, etc. | credential keyword bag (best_effort) | CREDENTIAL_PATH_RULE | capability guard (deny without fs.secret) | deny |
| `command_execution` | Tool triggers shell exec, subprocess spawn, arbitrary code run | keyword bag, n-gram (best_effort) | SHELL_EXEC_CAPABILITY_RULE | capability guard (deny without exec.shell) | ask_user or deny |
| `ssrf` | Args contain localhost, 127.0.0.1, 169.254.x.x, cloud metadata endpoint | URL/host pattern (best_effort) | SSRF_LOCALHOST_RULE | policy deny | deny |
| `filesystem_escape` | Args reference paths outside the expected workspace | path pattern (best_effort) | CREDENTIAL_PATH_RULE | capability guard (deny without fs.write) | deny |
| `scope_escalation` | Payload claims elevated authority or requests policy bypass | privilege-escalation keyword (best_effort) | capability guard | capability registry deny | deny |
| `cross_tenant_access` | Args contain a tenant/org identifier that does not match the active tenant | tenant-segment pattern in args (best_effort) | makeTenantIsolationRule | tenant isolation rule deny | deny |
| `tool_shadowing` | Tool impersonates a trusted tool by name-squatting or schema mimicry | name-squatting pattern (best_effort) | static vetting warning/deny | policy warn or deny | warn or deny |
| `rug_pull` | Descriptor swapped after initial registration (hash mismatch) | descriptor hash mismatch (deterministic) | snapshotTool / detectRugPull | consent invalidated, policy deny | deny |
| `sampling_abuse` | MCP server injects a system prompt via sampling/createMessage | privilege-escalation claim in sampling descriptor (best_effort) | DENY_BLOCKED_RULE | policy deny | deny |
| `supply_chain` | Unverified MCP server provenance (no operatorVerified flag) | n_gram / best_effort provenance check | ServerCard.operatorVerified=false triggers warn | none | warn |
| `consent_bypass` | Call proceeds without required user consent, or with stale consent | not_applicable (deterministic) | consent ledger + argument scope binding | consent ledger deny | deny |
| `tainted_output_reentry` | Tool return value contains adversarial instructions that re-enter the prompt as trusted content | adversarialScore > 0.5, instructionLikeTextDetected (best_effort) | taint boundary | taint quarantine / boundary tag | quarantine |

---

## Signal legend

| Signal type | Meaning |
|-------------|---------|
| `best_effort` | Keyword bag (stage 1) or n-gram classifier (stage 2); adaptive adversary can bypass with novel phrasing |
| `deterministic` | Same input produces the same decision and the rule does not depend on probabilistic or ML inference (hash comparison, path classification, tenant-segment regex). Deterministic does NOT imply complete coverage of all semantically equivalent encodings, resource forms, or hidden server-side effects |
| `not_applicable` | No semantic signal involved; enforcement is purely structural |

---

## Interactions between layers

The layers are independent and additive — a bypass of one layer does not disable
downstream layers. The key interactions are:

1. **Detector miss + policy deny** — the most common A1 scenario. Detection runs
   first but misses; policy still evaluates the call context (vetting outcome,
   consent state, sink classification) and may deny independently.

2. **Policy allow + taint quarantine** — if policy allows a call but the result
   contains adversarial content (`adversarialScore > 0.5`), taint tracking
   quarantines the observation before it can re-enter the prompt.

3. **Rug-pull + consent invalidation** — when `detectRugPull` fires, the consent
   ledger automatically invalidates all prior consent records bound to the old
   descriptor hash. A subsequent call requiring consent will get `consent=invalid`
   and be denied.

4. **Capability grant + tenant isolation** — `makeCapabilityPolicyRule` and
   `makeTenantIsolationRule` operate on structural properties (tool name, arg
   patterns) with no dependency on the semantic detection layer. They fire even
   when detection is `missed` or `not_applicable`.

---

## Property that this threat model is designed to preserve

> For every in-scope attack category, at least one deterministic boundary
> (policy rule, sink guard, capability check, taint label, or consent record)
> constrains the unsafe effect even when all semantic detection signals are `missed`.

This is the formalisation of the flagship invariant. It is tested in the frozen
holdout, deterministic text-mutation, and structural-mutation suites (FW-09 CI
gate). Adaptive and external red-team evaluation remain pending. A report
demonstrating a category where no deterministic boundary fires (A4 bypass) is
treated as P0.

---

*For the security model and bypass classification, see
[`mcp-firewall-security-model.md`](./mcp-firewall-security-model.md).*
*For reporting, see [`mcp-firewall-reporting.md`](./mcp-firewall-reporting.md).*
