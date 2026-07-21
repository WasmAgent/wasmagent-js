# AEP DSSE Alignment Notes

> Documents the current alignment between wasmagent's AEP (Audit Event Protocol)
> DSSE implementation and the in-toto attestation framework standard.

## Overview

The AEP package (`packages/aep`) uses DSSE (Dead Simple Signing Envelope) from
the in-toto/SLSA ecosystem to sign audit records. This document summarises three
known gaps between our implementation and the broader in-toto community
conventions, along with our current position on each.

---

## Gap 1: Canonicalization

| Aspect | Our Implementation | Community Standard |
|--------|-------------------|-------------------|
| Algorithm | Sorted-key `JSON.stringify` (recursive lexicographic key sort) | RFC 8785 — JSON Canonicalization Scheme (JCS) |
| Float handling | V8/SpiderMonkey default `Number.toString()` | JCS specifies IEEE 754 serialisation rules |
| Large integers | Standard JS number serialisation | JCS has specific rules for integers outside safe range |
| Non-ASCII | UTF-16 surrogate pairs as-is from engine | JCS normalises to UTF-8 with specific escape rules |

**Current position**: Intentional pre-1.0 simplification. Our canonical form is
sufficient for single-implementation verification (wasmagent ecosystem only).
The `payloadType` in the DSSE envelope distinguishes our format:

```
payloadType: "application/vnd.in-toto+json"
predicateType: "https://wasmagent.dev/attestations/aep/v0.4"
```

The predicate version (`v0.4`) signals that verifiers must use our sorted-key
canonicalization rather than JCS.

**Future**: Before 1.0, evaluate migrating to RFC 8785 (JCS) for full
cross-implementation interoperability. The migration path is a new predicate
version bump (`v1.0`) with JCS canonicalization.

---

## Gap 2: `subject[]` Semantics

| Aspect | Our Implementation | in-toto Convention |
|--------|-------------------|-------------------|
| Subject name | `urn:wasmagent:run:{runId}` | Typically a file path or artifact URI |
| Subject digest | `{ sha256: <payload_hash> }` | SHA-256 of the artifact bytes |
| Binding meaning | Session/run identity | Artifact identity |

**Current position**: We use `subject[].name` for **session binding** — the
subject identifies the agent session (run) that produced the audit record,
not a file artifact.

The structure is:

```json
{
  "subject": [
    {
      "name": "urn:wasmagent:run:<session_id>",
      "digest": {
        "sha256": "<canonical_record_hash>"
      }
    }
  ]
}
```

Where:
- `name` = session identifier (run ID) as a URN
- `digest.sha256` = SHA-256 of the canonicalized AEP record bytes

This aligns with in-toto's model of "what was attested about" but extends
the `name` field beyond file artifacts to runtime sessions.

---

## Gap 3: Session Binding

| Aspect | Our Implementation | in-toto Typical Use |
|--------|-------------------|-------------------|
| Binding mechanism | Subject name field contains session URN | Subjects are build artifacts |
| Scope | Per-run attestation | Per-build/release attestation |
| Chain of custody | Single envelope per record | Multiple attestations per artifact |

**Current position**: Session binding is achieved via the `subject[].name`
field. The session ID (run ID) appears as a URN in the subject, creating a
cryptographic binding between the DSSE envelope and the agent session that
generated the audit event.

This diverges from typical in-toto usage where subjects are build outputs
(container images, binaries). Our usage is closer to runtime attestation
patterns discussed in the in-toto community for runtime/SBOM use cases.

---

## Summary Table

| Gap | Status | Severity | Migration Path |
|-----|--------|----------|----------------|
| Canonicalization (not JCS) | Documented, intentional | Low (single-impl) | Predicate version bump to v1.0 with JCS |
| subject[] semantics | Session binding via URN | Low (valid extension) | No change needed; URN scheme is extensible |
| Session binding | Via subject name field | Low (convention diff) | Align with runtime attestation patterns as community evolves |

All three gaps are acceptable for pre-1.0 and are documented in source code
comments. Verifiers within the wasmagent ecosystem handle these correctly.
Cross-ecosystem verification (e.g., SLSA verifiers, Sigstore policy engines)
will require the JCS migration and potentially a subject mapping layer.
