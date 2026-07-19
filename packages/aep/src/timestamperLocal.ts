import { createHash } from "node:crypto";
import type { AEPTimestamper, TimestampProof } from "./timestamper.js";

/**
 * LocalTimestamper — in-process timestamper for development and testing.
 *
 * Produces a timestamp proof by hashing the input with the current time.
 * NOT suitable for production (provides no third-party trust) — use a
 * real TSA or Rekor for production deployments.
 */
export class LocalTimestamper implements AEPTimestamper {
  readonly authorityId: string;

  constructor(authorityId = "local-dev-tsa") {
    this.authorityId = authorityId;
  }

  async timestamp(recordBytes: Uint8Array): Promise<TimestampProof> {
    const now = new Date().toISOString();
    const hash = createHash("sha256").update(recordBytes).update(now).digest("base64");
    return {
      timestamp: now,
      authority: this.authorityId,
      proof: hash,
    };
  }
}
