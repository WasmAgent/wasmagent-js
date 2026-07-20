import * as ed from "@noble/ed25519";

/**
 * DSSE (Dead Simple Signing Envelope) — industry standard from in-toto/SLSA.
 * @see https://github.com/secure-systems-lab/dsse/blob/master/envelope.md
 */
export interface DSSEEnvelope {
  payloadType: string; // "application/vnd.in-toto+json"
  payload: string; // base64-encoded in-toto Statement JSON
  signatures: DSSESignature[];
}

export interface DSSESignature {
  keyid: string;
  sig: string; // base64-encoded signature over PAE(payloadType, payload)
}

/**
 * in-toto Statement wrapping the AEP payload.
 */
export interface InTotoStatement {
  _type: "https://in-toto.io/Statement/v1";
  subject: Array<{ name: string; digest: Record<string, string> }>;
  predicateType: string; // "https://wasmagent.dev/attestations/aep/v0.4"
  predicate: Record<string, unknown>; // The AEP record fields (minus signature)
}

/**
 * PAE (Pre-Authentication Encoding) — the canonical encoding DSSE signs over.
 * PAE(type, body) = "DSSEv1" + SP + len(type) + SP + type + SP + len(body) + SP + body
 */
export function paeEncode(payloadType: string, payload: string): Uint8Array {
  const encoder = new TextEncoder();
  const typeBytes = encoder.encode(payloadType);
  const payloadBytes = encoder.encode(payload);
  const header = encoder.encode(`DSSEv1 ${typeBytes.length} `);
  const mid = encoder.encode(` ${payloadBytes.length} `);
  const result = new Uint8Array(
    header.length + typeBytes.length + mid.length + payloadBytes.length
  );
  result.set(header, 0);
  result.set(typeBytes, header.length);
  result.set(mid, header.length + typeBytes.length);
  result.set(payloadBytes, header.length + typeBytes.length + mid.length);
  return result;
}

/**
 * Wrap an unsigned AEP record into an in-toto Statement.
 */
export function wrapInTotoStatement(
  record: Record<string, unknown>,
  runId: string,
  payloadDigest: string
): InTotoStatement {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `urn:wasmagent:run:${runId}`, digest: { sha256: payloadDigest } }],
    predicateType: "https://wasmagent.dev/attestations/aep/v0.4",
    predicate: record,
  };
}

/**
 * Verify a DSSE envelope against a public key.
 *
 * Steps:
 * 1. Reconstruct PAE from envelope.payloadType + envelope.payload
 * 2. Verify each signature against PAE bytes
 * 3. Return true if at least one signature verifies
 */
export async function verifyDSSEEnvelope(
  envelope: DSSEEnvelope,
  publicKey: Uint8Array
): Promise<boolean> {
  try {
    if (!envelope.signatures || envelope.signatures.length === 0) {
      return false;
    }
    const paeBytes = paeEncode(envelope.payloadType, envelope.payload);
    for (const sig of envelope.signatures) {
      const sigBytes = Uint8Array.from(Buffer.from(sig.sig, "base64"));
      const valid = await ed.verifyAsync(sigBytes, paeBytes, publicKey);
      if (valid) return true;
    }
    return false;
  } catch {
    return false;
  }
}
