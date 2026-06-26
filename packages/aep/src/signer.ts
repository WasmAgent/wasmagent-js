import * as ed from "@noble/ed25519";

/**
 * AEPSigner — pluggable signing interface.
 *
 * Implement this interface to swap in a KMS adapter (AWS KMS, GCP KMS, etc.)
 * without changing the AEPEmitter call site.
 *
 * KMS adapter shape (for reference — not implemented in this package):
 *
 * ```ts
 * class AwsKmsSigner implements AEPSigner {
 *   constructor(readonly keyId: string, private client: KMSClient) {}
 *   async sign(bytes: Uint8Array): Promise<string> {
 *     const resp = await this.client.send(new SignCommand({
 *       KeyId: this.keyId,
 *       Message: bytes,
 *       SigningAlgorithm: "ED25519",
 *     }));
 *     return Buffer.from(resp.Signature!).toString("base64");
 *   }
 * }
 * ```
 */
export interface AEPSigner {
  /** Stable key identifier stored in the AEPRecord signature block. */
  readonly keyId: string;

  /**
   * Sign the provided bytes and return a base64-encoded signature string.
   *
   * @param bytes - The canonical serialisation of the unsigned AEPRecord.
   * @returns base64-encoded ed25519 signature (or equivalent for KMS adapters).
   */
  sign(bytes: Uint8Array): Promise<string>;
}

/**
 * LocalEd25519Signer — in-process ed25519 signer backed by @noble/ed25519.
 *
 * Suitable for development, CI, and environments where a hardware KMS is
 * unavailable. For production, replace with a KMS adapter that implements
 * the AEPSigner interface above.
 */
export class LocalEd25519Signer implements AEPSigner {
  readonly keyId: string;
  readonly #secretKey: Uint8Array;
  #publicKey: Uint8Array | undefined;

  constructor(keyId: string, secretKey: Uint8Array) {
    this.keyId = keyId;
    this.#secretKey = secretKey;
  }

  async sign(bytes: Uint8Array): Promise<string> {
    const sigBytes = await ed.signAsync(bytes, this.#secretKey);
    return Buffer.from(sigBytes).toString("base64");
  }

  /** Returns the corresponding Ed25519 public key bytes (32 bytes). */
  async getPublicKey(): Promise<Uint8Array> {
    if (!this.#publicKey) {
      this.#publicKey = await ed.getPublicKeyAsync(this.#secretKey);
    }
    return this.#publicKey;
  }
}

/**
 * createLocalSignerFromSeed — create a LocalEd25519Signer from a 32-byte hex seed.
 *
 * @param seedHex - 64-character hex string representing 32 secret key bytes.
 * @param keyId   - Stable key identifier (e.g. "local-dev-key-01").
 *
 * @example
 * ```ts
 * const signer = createLocalSignerFromSeed(
 *   "a".repeat(64),   // 32 zero-ish bytes for dev/testing
 *   "local-dev-key-01"
 * );
 * ```
 */
export function createLocalSignerFromSeed(
  seedHex: string,
  keyId: string
): LocalEd25519Signer {
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    throw new Error(
      "seedHex must be a 64-character hexadecimal string (32 bytes)"
    );
  }
  const bytes = Uint8Array.from(Buffer.from(seedHex, "hex"));
  return new LocalEd25519Signer(keyId, bytes);
}
