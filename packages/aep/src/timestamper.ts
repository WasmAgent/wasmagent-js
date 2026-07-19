/**
 * AEPTimestamper — optional pluggable timestamping interface.
 *
 * When configured on AEPEmitter, produces an external timestamp proof
 * for each record, proving the record existed at a given time from an
 * independent third party. This prevents backdating.
 *
 * Implementation options:
 * - RFC 3161 TSA (traditional PKI timestamp authorities)
 * - Sigstore Rekor (keyless, publicly auditable transparency log)
 * - Custom internal TSA
 */
export interface AEPTimestamper {
  /** Human-readable identifier for the timestamping authority. */
  readonly authorityId: string;

  /**
   * Request a timestamp for the given record bytes.
   * Returns an opaque proof string (format depends on implementation).
   *
   * @param recordBytes - The canonical serialisation of the AEP record.
   * @returns Opaque timestamp proof (e.g. base64 RFC 3161 TimeStampResp, or Rekor log entry).
   */
  timestamp(recordBytes: Uint8Array): Promise<TimestampProof>;
}

export interface TimestampProof {
  /** ISO 8601 UTC timestamp from the authority. */
  timestamp: string;
  /** Authority identifier (mirrors AEPTimestamper.authorityId). */
  authority: string;
  /** Opaque proof blob — format depends on the authority type. */
  proof: string;
  /** Optional: transparency log index (e.g. Rekor log index). */
  logIndex?: number;
}
