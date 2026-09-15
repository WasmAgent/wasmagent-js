---
"@wasmagent/mcp-firewall": minor
---

Adversarial hardening waves 1–4: promote to F2 phase

**Wave 1 — Baseline & corpus (FW-01 to FW-04)**
- Add `package-metadata.json` as single source of truth for maturity/phase
- Freeze adversarial corpus: 60 samples across 9 categories, stratified 38/11/11 train/dev/holdout split
- Add `normalize.ts`: 11-stage normalization pipeline (URL decode, HTML entity, base64, homoglyph, full-width, zero-width stripping) with bounded decode depths
- `vetTool` now normalizes text before keyword scanning — catches URL-encoded, base64-obfuscated, and full-width injection attempts
- Add mutation framework: 22 deterministic mutators (homoglyph, base64, URL encode, hex escape, zero-width, case mix, leet, reversed text, multilingual prefix, and more)

**Wave 2 — Layered verdict & structural policy (FW-05 to FW-08)**
- Add `FirewallSecurityVerdict`: typed 5-layer verdict (detection / policy / containment / consent / taint / final)
- Add `composeVerdict()`: correctly maps detection=missed + policy=deny to containment=contained
- Add `sink-policy.ts`: DataSource/DataSink classification with four hard policy rules:
  - `CREDENTIAL_PATH_RULE`: deny access to ~/.ssh, ~/.aws, /etc/shadow, etc.
  - `SECRET_NETWORK_SINK_RULE`: deny secret-bearing args sent to network sinks
  - `SSRF_LOCALHOST_RULE`: deny localhost/169.254.x/metadata endpoint fetches
  - `SHELL_EXEC_CAPABILITY_RULE`: escalate shell-exec tools to ask_user
- `FULL_DEFAULT_RULES` = DEFAULT_RULES + SINK_POLICY_RULES
- Add `capability.ts`: EffectClass classification, CapabilityRegistry, cross-tenant detection
- Extend `TaintLabel` to 9 semantic labels surviving transformation chains
- Extend `ConsentEvent`/`ConsentCacheKey` with `argScopeDigest` + `boundToSession` anti-replay

**Wave 3 — CI & documentation (FW-09 to FW-10)**
- Add `.github/workflows/mcp-firewall-adversarial.yml`: 7-job adversarial CI pipeline (corpus integrity, mutation detection, F2 gate)
- Add `docs/security/mcp-firewall-security-model.md`, `threat-model.md`, `reporting.md`
- Update `SECURITY.md` with mcp-firewall vulnerability classification

**Wave 4 — F2 gate & observability (FW-F2)**
- Add `critical-action-escape.test.ts`: proves `critical_action_escape_rate = 0` across 242 mutation scenarios (11 holdout × 22 mutators) — structural policy rules block all dangerous effects even when semantic detection misses
- Add `observability.ts`: `FIREWALL_METRIC_NAMES`, `InMemoryMetricsRecorder`, `verdictToMetrics()` — maps every `FirewallSecurityVerdict` to Prometheus-style counters including the DETECTOR_MISS_CONTAINED_TOTAL / UNSAFE_ESCAPE_TOTAL split
- Add `scripts/generate-redteam.mjs`: rule-based paraphrase generator for offline red-team sample creation
- Promote `package-metadata.json` to phase F2 (`adversarial_evaluation: partial_f2`)
