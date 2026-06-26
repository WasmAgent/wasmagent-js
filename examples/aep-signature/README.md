# AEP Signature Bundle Example

Minimal example showing how to attach a `signature` bundle to an `AEPRecord` using the
`@wasmagent/aep` package.

> **Note**: The HMAC-SHA256 example below uses a dummy key for illustration. Production
> deployments should use asymmetric keys (ECDSA P-256 or Ed25519) and, ideally, sign via
> a Sigstore-compatible workflow so records are logged in a transparency log (Rekor).

## Install

```bash
npm install @wasmagent/aep
# or
bun add @wasmagent/aep
```

## TypeScript example

```ts
import { createHash, createHmac } from "node:crypto";
import { AEPRecordSchema, type AEPRecord } from "@wasmagent/aep";

// ---------------------------------------------------------------------------
// 1. Build the record (without signature first)
// ---------------------------------------------------------------------------
const recordWithoutSig = {
  schema_version: "aep/v0.2" as const,
  run_id: "run_01j9xkz3m4p5q6r7s8t9u0v",
  trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
  model_provider: "anthropic",
  model_id: "claude-sonnet-20250514",
  policy_bundle_digest: "sha256:deadbeef00000001",
  tool_manifest_digest: "sha256:deadbeef00000002",
  actions: [
    {
      action_id: "act_001",
      tool_name: "fs_write",
      state_changing: true,
      result_digest: "sha256:cafebabe00000001",
      timestamp_ms: Date.now(),
    },
  ],
  verifier_results: [],
  created_at_ms: Date.now(),
};

// ---------------------------------------------------------------------------
// 2. Compute canonical payload (keys sorted, no extra whitespace)
//    This is the byte string that gets signed — same convention as JWS.
// ---------------------------------------------------------------------------
const canonicalPayload = JSON.stringify(
  recordWithoutSig,
  Object.keys(recordWithoutSig).sort()
);

// ---------------------------------------------------------------------------
// 3. Sign — HMAC-SHA256 with a dummy key (replace with real key management)
// ---------------------------------------------------------------------------
const SIGNING_KEY = process.env.AEP_SIGNING_KEY ?? "dev-only-dummy-key-do-not-use";
const sigBytes = createHmac("sha256", SIGNING_KEY)
  .update(canonicalPayload)
  .digest();
const sigBase64 = sigBytes.toString("base64");

// ---------------------------------------------------------------------------
// 4. Attach the signature bundle
// ---------------------------------------------------------------------------
const signedRecord: AEPRecord = AEPRecordSchema.parse({
  ...recordWithoutSig,
  signature: {
    alg: "hmac-sha256",
    key_id: "dev-key-v1",
    sig: sigBase64,
    // Optional: attach a Sigstore bundle (populated by your CI signing step)
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.3",
      dsseEnvelope: {
        payload: Buffer.from(canonicalPayload).toString("base64"),
        payloadType: "application/vnd.wasmagent.aep+json",
        signatures: [{ sig: sigBase64, keyid: "dev-key-v1" }],
      },
    },
    // Optional: Rekor transparency log entry (populated after cosign upload)
    transparency_log_ref:
      "https://rekor.sigstore.dev/api/v1/log/entries/24296fb24b8ad77ac2a5a34e74a8e18eb73ee0d85f77a50c7968bab5d5b4f6d3e4da50a",
  },
});

console.log(JSON.stringify(signedRecord, null, 2));
```

## Verify (conceptual)

```ts
import { createHmac } from "node:crypto";
import type { AEPRecord } from "@wasmagent/aep";

function verifyAEPRecord(record: AEPRecord, key: string): boolean {
  if (!record.signature) return false;
  const { signature: sig, ...rest } = record;
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  const expected = createHmac("sha256", key).update(canonical).digest("base64");
  return sig.sig === expected;
}
```

For production (ECDSA + Rekor), delegate to `cosign verify-blob` — see
[`docs/security/aep-signature-bundle.md`](../../docs/security/aep-signature-bundle.md)
for the full verification steps and standards coverage.
