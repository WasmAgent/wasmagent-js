# Standards Alignment

> How wasmagent assembles existing open standards for agent runtime boundary recording — and why we chose each one.

---

## 1. Why align with standards

wasmagent records **what agents did at runtime boundaries** — tool calls, capability decisions, state changes, delegation events. These records must be:

- **Interoperable** — consumable by third-party audit tools, SIEMs, compliance pipelines, and training-data extractors without bespoke adapters.
- **Auditable** — verifiable by independent parties using off-the-shelf cryptographic tooling.
- **Low maintenance** — riding community-maintained specs avoids the cost of evolving a bespoke wire format.
- **Community-trusted** — adopting standards that reviewers already know reduces the barrier for external security audits and open-source contribution.

The project's explicit non-goal is inventing new standards. Where an existing spec covers a need, wasmagent conforms to it. Where no single spec covers the full requirement, we compose multiple standards — and the **composition** is the contribution.

---

## 2. OTel GenAI Semantic Conventions

**Spec:** [OpenTelemetry Semantic Conventions for GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/)

**Stability:** Development / Experimental (as of semconv 1.28.0). Attribute names, event semantics, and metric instruments may change in minor releases.

### What wasmagent uses

| Convention | Usage in wasmagent |
|---|---|
| `gen_ai.*` attribute namespace | All LLM-related span attributes follow the `gen_ai.*` naming (`gen_ai.operation.name`, `gen_ai.usage.input_tokens`, etc.). See `packages/otel-exporter/src/aep-span-names.ts`. |
| Content capture via span events | Prompt/response content is attached as span *events* (`gen_ai.user.message`, `gen_ai.assistant.message`, `gen_ai.choice`) — not as span attributes. This follows the semconv guidance that large/variable content belongs in events. |
| `gen_ai.operation.name` | Used to distinguish `chat`, `invoke_agent`, `execute_tool` operations. |

### What wasmagent does NOT reimplement

- The OTel SDK itself — we export OTLP JSON via `@wasmagent/otel-exporter` and rely on standard collectors (Jaeger, Tempo, etc.) for storage/query.
- Metric instruments — we emit metric data points to `/v1/metrics` using the OTel counter/histogram semantics but do not bundle an OTel metrics SDK.

### What to watch

- The GenAI semconv is in `Development` stability; attribute renames are possible. `@wasmagent/otel-exporter` tracks the `OTEL_SEMCONV_STABILITY_OPT_IN` env var so consumers can opt into breaking changes incrementally.
- Span kind for agent operations (currently `SPAN_KIND_SERVER` in our exporter) may be refined once the semconv stabilises.

**Cross-reference:** `packages/otel-exporter/`, `packages/devtools/src/genaiOtelAdapter.ts`

---

## 3. in-toto Attestation Framework + DSSE

**Spec:** [in-toto Attestation Framework v1.0](https://github.com/in-toto/attestation/blob/main/spec/v1/README.md), [Dead Simple Signing Envelope (DSSE)](https://github.com/secure-systems-lab/dsse)

**Stability:** in-toto Attestation v1.0 is stable/released. DSSE is stable.

### What wasmagent uses

AEP records are structurally modelled after in-toto Statements:

| in-toto concept | AEP mapping |
|---|---|
| `Statement._type` | `"https://in-toto.io/Statement/v1"` (conceptual; AEP uses `schema_version: "aep/v0.2"`) |
| `Statement.subject` | `run_id`, `trace_id`, `input_refs` (the artefacts being attested) |
| `Statement.predicateType` | A custom type: `"https://wasmagent.dev/aep/v0.2"` — this is standards-conformant; in-toto explicitly permits custom predicateTypes. |
| `Statement.predicate` | The AEP record body (actions, capability_decisions, verifier_results, budget_ledger, etc.) |
| DSSE envelope | The `signature` block (`alg: "ed25519"`, `key_id`, `sig`) wraps the canonical payload exactly as DSSE prescribes: sign the canonical bytes of the payload, attach the signature externally. |

### What wasmagent does NOT reimplement

- The in-toto layout/verification engine — AEP records are single-predicate attestations, not multi-step supply-chain layouts.
- DSSE multi-signature negotiation — we currently use a single signer per record.

### What to watch

- in-toto Attestation v1.1 (draft) may introduce predicate bundles. If shipped, AEP could bundle multiple action attestations in one envelope.
- DSSE PAE (pre-authentication encoding) is already stable; no breaking changes expected.

**Cross-reference:** `packages/aep/src/canonical.ts`, `packages/aep/src/signer.ts`, `packages/aep/src/verify.ts`

---

## 4. SLSA Provenance

**Spec:** [SLSA Provenance v1.0](https://slsa.dev/provenance/v1)

**Stability:** v1.0 is stable/released.

### Relationship to AEP

SLSA Provenance and AEP are **complementary**, not competing:

| Dimension | SLSA Provenance | AEP |
|---|---|---|
| Scope | Build-time: "how was this artefact built?" | Runtime: "what did the agent do during execution?" |
| Subject | Build output (binary hash, container digest) | Run output (action evidence, capability decisions) |
| Predicate | `https://slsa.dev/provenance/v1` | `https://wasmagent.dev/aep/v0.2` |
| Envelope | DSSE-signed in-toto Statement | DSSE-signed in-toto Statement |

Both are DSSE-signed in-toto Statements with different predicateTypes. A fully attested agent deployment would carry:
1. SLSA provenance for the agent binary/image (build-time).
2. AEP records for each run (runtime).

### What wasmagent does NOT reimplement

- SLSA builders / provenance generators — use `slsa-github-generator` or equivalent for CI.
- SLSA verification — use `slsa-verifier` to check build provenance.

### What to watch

- SLSA v1.1 (draft) may add runtime attestation guidance. If it does, AEP's predicateType could be registered as an official SLSA predicate.

**Cross-reference:** `packages/aep/`, `docs/security/aep-signature-bundle.md`

---

## 5. Sigstore / Rekor

**Spec:** [Sigstore](https://www.sigstore.dev/), [Rekor transparency log](https://docs.sigstore.dev/logging/overview/)

**Stability:** Sigstore GA (production). Rekor is production-stable.

### Current state in wasmagent

wasmagent currently ships `LocalEd25519Signer` — a local deterministic signer suitable for development and testing. This is explicitly a **stepping stone**:

| Signer | Trust model | Use case |
|---|---|---|
| `LocalEd25519Signer` | Self-signed, key managed by operator | Dev, testing, single-tenant trusted environments |
| Sigstore (upgrade path) | Keyless signing via OIDC, entries logged to Rekor | Production multi-tenant, public auditability |

### Upgrade path

1. Replace `LocalEd25519Signer` with a Sigstore Fulcio-issued short-lived certificate.
2. Upload the DSSE envelope to Rekor for public transparency.
3. Verifiers check the Rekor inclusion proof instead of requiring out-of-band public key distribution.

### What wasmagent does NOT reimplement

- The Sigstore signing client — use `sigstore-js` or `cosign`.
- The Rekor transparency log — use the public Rekor instance or a private instance.
- Certificate authority — Fulcio handles OIDC-to-certificate binding.

### What to watch

- Sigstore bundle format (v0.3) for packaging attestation + certificate + Rekor entry.
- `sigstore-js` NPM package stability — currently pre-1.0 but widely adopted.

**Cross-reference:** `packages/aep/src/signer.ts` (`AEPSigner` interface), `packages/aep/README.md` (KMS adapter section)

---

## 6. W3C PROV-DM

**Spec:** [W3C PROV-DM](https://www.w3.org/TR/prov-dm/) (Provenance Data Model)

**Stability:** W3C Recommendation (stable, 2013). Unlikely to change.

### What wasmagent uses

PROV-DM provides a formal vocabulary for **multi-agent causality**:

| PROV-DM concept | wasmagent mapping |
|---|---|
| `Entity` | An AEP record, a tool output, a memory snapshot |
| `Activity` | An agent step, a tool invocation, a delegation event |
| `Agent` | A sub-agent, the orchestrator, a human approver |
| `used` | Activity consumed an Entity (tool read a file) |
| `wasGeneratedBy` | Entity was produced by an Activity (tool wrote a file) |
| `wasAssociatedWith` | Activity was performed by an Agent |
| `wasDerivedFrom` | Entity was derived from another Entity (taint propagation) |

The `packages/devtools` EventLogReplay engine uses PROV-DM edge types to express causal dependencies between events in multi-agent traces, enabling dependency-based replay (select all causal ancestors of a target event) rather than pure linear-prefix replay.

### What wasmagent does NOT reimplement

- PROV-N serialisation — we use our own JSON edge format (`ProvEdge`) that maps 1:1 to PROV-DM relations.
- PROV-CONSTRAINTS validation — we do not enforce all PROV-DM validity constraints (e.g., temporal ordering of generation/usage).
- Full PROV-O (OWL ontology) — we use the data model vocabulary, not the RDF serialisation.

### What to watch

- PROV-DM is a W3C Recommendation and frozen. No changes expected.
- Community tooling (e.g., `prov` Python library) can ingest PROV-DM; if demand arises, we could emit PROV-JSON alongside our native format.

**Cross-reference:** `packages/devtools/src/EventLogReplay.ts`, `packages/aep/src/types.ts` (`parent_action_id`, `causal_chain_id`)

---

## 7. "The combination is the contribution"

No single standard above was designed for "agent runtime boundary recording." Each covers one facet:

| Standard | Facet covered |
|---|---|
| OTel GenAI semconv | Observable telemetry (spans, metrics, events) |
| in-toto + DSSE | Attestation envelope + cryptographic binding |
| SLSA Provenance | Build-time supply chain (complementary) |
| Sigstore / Rekor | Public-key transparency + keyless signing |
| W3C PROV-DM | Multi-agent causal graph vocabulary |

wasmagent's architectural contribution is **assembling** these standards into a coherent agent evidence pipeline:

```
Agent runtime
  --> OTel spans (GenAI semconv attributes + events)
  --> AEP records (in-toto Statement, DSSE-signed)
  --> Optional: Rekor transparency entry (Sigstore)
  --> Causal graph (PROV-DM edges in devtools replay)
```

Each layer is replaceable. If a better signing standard emerges, swap the signer. If OTel semconv stabilises with breaking renames, bump the attribute map. The composition is intentionally loose-coupled so individual standards can evolve independently.

### Design principles

1. **Conform, do not fork.** If a standard says "put content in events not attributes," we do that — even if attributes would be easier to query.
2. **Custom predicateType is conformant.** in-toto explicitly supports custom predicates. We do not pretend AEP is SLSA Provenance.
3. **Upgrade paths over lock-in.** `LocalEd25519Signer` ships today; Sigstore is the documented next step, not a rewrite.
4. **Maturity labels.** Each standard has a different stability level. We track them and version our conformance accordingly (`GENAI_SEMCONV_VERSION` in the otel-exporter, `schema_version` in AEP records).
