# AEP Signature Bundle

The `signature` field on `AEPRecord` provides **SLSA-style provenance** for agent actions: a
tamper-evident, optionally transparency-logged proof that a specific run record was produced by a
known agent identity and has not been modified after signing.

## Why it matters

An AEP record captures every state-changing tool call an agent made, the policy decisions that
governed them, and the verifier verdicts that assessed the output. Signing that record lets
downstream consumers — auditors, compliance pipelines, training-data curators — confirm:

- The record was produced by the declared `agent_id` / `model_id`.
- It has not been altered in transit (supply-chain tamper detection, OWASP-MCP-07).
- A transparency-log entry can be cross-checked independently of the originating system.

See [`standards-crosswalk.yaml`](./standards-crosswalk.yaml) under `owasp-mcp-07-supply-chain-tampering`
and `owasp-agentic-a07-supply-chain` for the full coverage mapping.

## Signature field structure

```ts
// From packages/aep/src/types.ts — AEPRecordSchema
signature: z.object({
  alg: z.string(),                      // e.g. "hmac-sha256", "ecdsa-p256-sha256"
  key_id: z.string(),                   // opaque key identifier
  sig: z.string(),                      // base64-encoded raw signature
  bundle: z.record(z.unknown()).optional(),          // Sigstore bundle (DSSE envelope)
  transparency_log_ref: z.string().optional(),       // Rekor log entry URL or UUID
}).optional()
```

### `bundle` — Sigstore / DSSE compatibility

The `bundle` field is typed as `Record<string, unknown>` so it can hold any Sigstore bundle
JSON without schema drift. A conforming bundle follows the
[Sigstore bundle format](https://github.com/sigstore/protobuf-specs/blob/main/protos/sigstore_bundle.proto)
and wraps a [DSSE envelope](https://github.com/secure-systems-lab/dsse) whose payload type is
`application/vnd.wasmagent.aep+json`.

Minimal structure when using Sigstore:

```json
{
  "mediaType": "application/vnd.dev.sigstore.bundle+json;version=0.3",
  "verificationMaterial": {
    "certificate": { "rawBytes": "<base64-DER>" }
  },
  "dsseEnvelope": {
    "payload": "<base64-canonical-AEP-record>",
    "payloadType": "application/vnd.wasmagent.aep+json",
    "signatures": [
      { "sig": "<base64-signature>", "keyid": "<key-id>" }
    ]
  }
}
```

## Complete signed AEP record (example)

The `sig` is computed over the **canonical JSON** of the record with the `signature` field
omitted (same convention as JWS detached payload).

```json
{
  "schema_version": "aep/v0.2",
  "run_id": "run_01j9xkz3m4p5q6r7s8t9u0v",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "repo_commit": "abc123def456",
  "model_provider": "anthropic",
  "model_id": "claude-sonnet-20250514",
  "policy_bundle_digest": "sha256:deadbeef00000001",
  "tool_manifest_digest": "sha256:deadbeef00000002",
  "actions": [
    {
      "action_id": "act_001",
      "tool_name": "fs_write",
      "state_changing": true,
      "result_digest": "sha256:cafebabe00000001",
      "timestamp_ms": 1750000000000
    }
  ],
  "verifier_results": [
    { "verifier_id": "DeterministicVerifier", "passed": true, "claim_ids": [] }
  ],
  "created_at_ms": 1750000001234,
  "signature": {
    "alg": "ecdsa-p256-sha256",
    "key_id": "wasmagent-signing-key-v1",
    "sig": "MEYCIQDexampleSignatureBase64AABBCCDDeEfFgGhHiIjJkKlLmMnN==",
    "bundle": {
      "mediaType": "application/vnd.dev.sigstore.bundle+json;version=0.3",
      "verificationMaterial": {
        "certificate": { "rawBytes": "MIIBexampleCertBase64==" }
      },
      "dsseEnvelope": {
        "payload": "<base64-canonical-record-without-signature-field>",
        "payloadType": "application/vnd.wasmagent.aep+json",
        "signatures": [
          {
            "sig": "MEYCIQDexampleSignatureBase64AABBCCDDeEfFgGhHiIjJkKlLmMnN==",
            "keyid": "wasmagent-signing-key-v1"
          }
        ]
      }
    },
    "transparency_log_ref": "https://rekor.sigstore.dev/api/v1/log/entries/24296fb24b8ad77ac2a5a34e74a8e18eb73ee0d85f77a50c7968bab5d5b4f6d3e4da50a"
  }
}
```

## How to verify

Verification is intentionally kept as data-only steps so any runtime can implement it.

### Step 1 — Check algorithm support

Read `signature.alg`. WasmAgent records currently use `hmac-sha256` (test/dev) or
`ecdsa-p256-sha256` (production). Reject unknown algorithms.

### Step 2 — Reconstruct the canonical payload

Strip the `signature` key from the record and serialize to canonical JSON
(keys sorted, no insignificant whitespace). This is the byte string that was signed.

```ts
const { signature: _sig, ...rest } = record;
const payload = JSON.stringify(rest, Object.keys(rest).sort());
```

### Step 3 — Verify the raw signature

Use `signature.key_id` to look up the public key, then verify `signature.sig`
(base64-decoded) against the canonical payload bytes using the declared `alg`.

### Step 4 — Check the transparency log (optional but recommended)

If `transparency_log_ref` is present, fetch the Rekor log entry at that URL and confirm:
- The entry's `body.spec.data.hash` matches `sha256(canonicalPayload)`.
- The entry's integrated timestamp is plausible for the record's `created_at_ms`.

### Full Sigstore verification

For production workloads, delegate to the `cosign` CLI:

```bash
cosign verify-blob \
  --bundle bundle.json \
  --certificate-identity-regexp '.*wasmagent.*' \
  --certificate-oidc-issuer https://accounts.google.com \
  record.json
```

WasmAgent provides the data structure; full certificate-chain and CT-log verification
requires `cosign` or an equivalent Sigstore client library.

## Standards coverage

| Standard | Control | Field |
|---|---|---|
| OWASP-MCP-07 | Supply-chain tampering | `signature`, `tool_manifest_digest` |
| OWASP-Agentic-A07 | Supply-chain integrity | `signature.transparency_log_ref` |
| SLSA Build L2 | Provenance attestation | `bundle` (DSSE envelope) |
| in-toto | Link metadata | `actions[]` as in-toto steps |

See [`standards-crosswalk.yaml`](./standards-crosswalk.yaml) for the full mapping.

## Inter-record hash chain verification

Starting with the hash chain feature, AEP records can be linked in a tamper-evident
sequence. Each record carries an optional `prev_record_hash` field containing the SHA-256
hex digest of the previous record's canonical bytes (signature stripped).

### Trust model

The signature on each individual record proves **who** produced it and that the record
body has not been modified. The hash chain adds a second guarantee: **no record in the
sequence has been deleted, reordered, or inserted** after the fact.

Together these two mechanisms provide:

| Property | Mechanism |
|---|---|
| Integrity (single record) | Ed25519 signature over canonical bytes |
| Sequence integrity (chain) | `prev_record_hash` links each record to its predecessor |
| Non-repudiation | Signing key identity bound to `key_id` |
| Backward compatibility | `prev_record_hash` is optional (`.nullish()`) — older records without it are accepted |

### How it works

1. The `AEPEmitter` maintains internal state: the SHA-256 hex hash of the most recently
   emitted record's canonical bytes (without the `signature` field).
2. On every call to `emit()`, the emitter sets `prev_record_hash` in the new record's
   payload to that stored hash (or `null` for the first record in a session).
3. After signing and finalising the record, the emitter computes the canonical hash of the
   new record and stores it for the next emission.

### Verifying a chain

Use `verifyAEPChain(records)` from `@wasmagent/aep`:

```ts
import { verifyAEPChain } from "@wasmagent/aep";

const result = verifyAEPChain(orderedRecords);
if (!result.valid) {
  console.error(`Chain broken at index ${result.brokenAt}`);
}
```

The function iterates through the ordered array. For each record after the first, if
`prev_record_hash` is present, it recomputes the SHA-256 of the previous record's
canonical bytes and compares. A mismatch indicates tampering (deletion, reordering, or
insertion).

Records that lack `prev_record_hash` (null/undefined) are treated as valid links for
backward compatibility with pre-chain records.
