# WasmAgent Security Governance Pack

This pack answers the security questions enterprise evaluators ask before
adopting an agentic coding system.

## Contents

| Document | Answers |
|---|---|
| [threat-model.md](threat-model.md) | What can go wrong, what is blocked by design |
| [capability-manifest-guide.md](capability-manifest-guide.md) | How to configure the permission boundary |
| [owasp-agentic-map.md](owasp-agentic-map.md) | OWASP Agentic Top 10 → WasmAgent controls |
| [audit-events.md](audit-events.md) | What is logged and how to export it |
| [deployment-checklist.md](deployment-checklist.md) | Production hardening checklist |
| [pilot-script.md](pilot-script.md) | 30-minute enterprise pilot walkthrough |

## How to use this pack

**Security architects** — start with [threat-model.md](threat-model.md) for the
attack surface and then [owasp-agentic-map.md](owasp-agentic-map.md) for the
compliance mapping.

**Developers deploying WasmAgent** — [capability-manifest-guide.md](capability-manifest-guide.md)
defines the permission boundary and [deployment-checklist.md](deployment-checklist.md)
covers production hardening.

**Enterprise evaluators running a pilot** — follow [pilot-script.md](pilot-script.md).
All four scenarios produce evidence artifacts you can attach to a procurement review.

**Compliance / audit** — [audit-events.md](audit-events.md) documents every event
emitted, KV storage format, and OTel export bridge.

## Scope

This pack covers the runtime security model of the WasmAgent kernel and agent
framework. It does not cover:

- Cloudflare Workers platform security (see Cloudflare Trust & Safety docs).
- LLM provider safety (model-level content filtering is a provider concern).
- Your organisation's identity and access management layer.

## Related documents

- [`docs/security/capability-manifest-owasp.md`](../security/capability-manifest-owasp.md) —
  deep-dive OWASP coverage matrix with regulatory mapping (EU AI Act, ISO 42001).
- [`docs/schemas/GOVERNANCE.md`](../schemas/GOVERNANCE.md) — training data pipeline governance.
- [`packages/core/src/executor/types.ts`](../../packages/core/src/executor/types.ts) —
  canonical `CapabilityManifest` interface definition.
