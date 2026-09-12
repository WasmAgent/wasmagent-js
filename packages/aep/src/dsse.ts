import * as ed from "@noble/ed25519";

/**
 * DSSE (Dead Simple Signing Envelope) — industry standard from in-toto/SLSA.
 * @see https://github.com/secure-systems-lab/dsse/blob/master/envelope.md
 *
 * ## subject[] Semantics
 *
 * The `subject` array in the in-toto Statement contains entries of the form:
 *
 * ```json
 * [{ "name": "urn:wasmagent:run:<session_id>", "digest": { "sha256": "<record_hash>" } }]
 * ```
 *
 * - `name`: The session/run ID as a URN — provides **session binding** so the
 *   attestation is cryptographically tied to a specific agent execution.
 * - `digest.sha256`: SHA-256 hash of the canonicalized AEP record bytes
 *   (produced by `canonical.ts`'s sorted-key JSON.stringify).
 *
 * ## Alignment with in-toto Attestation Framework
 *
 * - We use `subject[].name` for session identity (not file/artifact paths),
 *   which extends the in-toto model to runtime attestation use cases.
 * - Our canonicalization is sorted-key JSON.stringify, NOT RFC 8785 (JCS).
 *   The `predicateType` version (v0.4) signals this to verifiers.
 * - Session binding is achieved solely via the subject name field — no
 *   separate session-binding extension is needed.
 *
 * See `docs/aep-dsse-alignment.md` for full gap analysis.
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
/**
 * The predicateType every AEP DSSE envelope MUST carry. Exactly this value —
 * matching the Rust verifier's AEP_PREDICATE_TYPE — is required at
 * verification; unknown or future versions fail closed until supported.
 */
export const AEP_PREDICATE_TYPE = "https://wasmagent.dev/attestations/aep/v0.4";

/**
 * The payloadType every AEP DSSE envelope MUST carry (in-toto statement).
 */
export const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

export function wrapInTotoStatement(
  record: Record<string, unknown>,
  runId: string,
  payloadDigest: string
): InTotoStatement {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `urn:wasmagent:run:${runId}`, digest: { sha256: payloadDigest } }],
    predicateType: AEP_PREDICATE_TYPE,
    predicate: record,
  };
}

/**
 * Verify a DSSE envelope against a public key.
 *
 * AEP signature-count policy: exactly one signature. Zero or multiple
 * signatures are rejected — current emitters produce one signature and this
 * verifier deliberately does not define multisig/threshold semantics.
 *
 * Steps:
 * 1. Require exactly one signature and the in-toto payload type
 * 2. Reconstruct PAE from envelope.payloadType + envelope.payload
 * 3. Verify the signature against the PAE bytes
 */
export async function verifyDSSEEnvelope(
  envelope: DSSEEnvelope,
  publicKey: Uint8Array
): Promise<boolean> {
  try {
    if (!envelope.signatures || envelope.signatures.length !== 1) {
      return false;
    }
    if (envelope.payloadType !== IN_TOTO_PAYLOAD_TYPE) {
      return false;
    }
    const paeBytes = paeEncode(envelope.payloadType, envelope.payload);
    const sigBytes = Uint8Array.from(Buffer.from(envelope.signatures[0]!.sig, "base64"));
    return await ed.verifyAsync(sigBytes, paeBytes, publicKey);
  } catch {
    return false;
  }
}
