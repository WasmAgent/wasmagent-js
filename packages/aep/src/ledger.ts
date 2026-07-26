import { createHash } from "node:crypto";
import { canonicalBytes } from "./canonical.js";
import type { EvidenceStore } from "./evidenceStore.js";
import type { AEPRecord } from "./types.js";

/**
 * Genesis sentinel — the `prevHash` value for the very first ledger record.
 *
 * An empty string was chosen because it is unambiguous: no SHA-256 digest
 * can produce an empty string, so a genesis record is always identifiable.
 */
export const GENESIS_PREV_HASH = "";

/**
 * LedgerRecord — a signed AEPRecord wrapped with ledger-level metadata.
 *
 * Each `LedgerRecord` carries:
 * - `seq`: a monotonically increasing sequence number (0-based).
 * - `prevHash`: SHA-256 hex digest of the previous `LedgerRecord`'s canonical
 *   serialization. For the genesis record (seq 0) this equals `GENESIS_PREV_HASH`.
 * - `record`: the fully-signed `AEPRecord` (signed by `AEPEmitter` or equivalent).
 * - `hash`: SHA-256 hex digest of *this* `LedgerRecord`'s canonical serialization
 *   (pre-computed so the next append can reference it without re-reading storage).
 *
 * ## Canonical serialization for hash computation
 *
 * The canonical form of a `LedgerRecord` used for both `hash` and `prevHash`
 * computation is the sorted-key JSON of `{ seq, prevHash, record }` — i.e.
 * the `hash` field is excluded (analogous to how `AEPRecord.signature` is
 * stripped before signing). This ensures:
 *
 * 1. The hash is stable and can be recomputed by any verifier.
 * 2. The hash does not depend on the `hash` field itself (circular dependency).
 *
 * ```ts
 * // Pseudocode for how `hash` is computed:
 * const unsigned = { seq, prevHash, record };
 * const bytes = canonicalBytes(unsigned);
 * hash = sha256hex(bytes);
 * ```
 */
export interface LedgerRecord {
  /** Monotonically increasing 0-based sequence number. */
  seq: number;
  /** SHA-256 hex digest of the previous LedgerRecord's canonical form. Empty string for genesis. */
  prevHash: string;
  /** The fully-signed AEPRecord. */
  record: AEPRecord;
  /** SHA-256 hex digest of this LedgerRecord's canonical form (excludes `hash` itself). */
  hash: string;
}

/**
 * Compute the SHA-256 hex digest of a LedgerRecord's canonical serialization.
 *
 * The `hash` field is excluded from the canonical form to avoid circularity.
 * Uses the same sorted-key JSON canonicalization as AEP record signing
 * (`canonicalBytes` from `./canonical.js`), ensuring interoperability.
 */
export function hashLedgerRecord(lr: LedgerRecord): string {
  const { hash: _hash, ...unsigned } = lr;
  const bytes = canonicalBytes(unsigned);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Options for constructing a {@link Ledger}.
 */
export interface LedgerOptions {
  /**
   * Optional backing EvidenceStore. When provided, each `append()` also
   * persists the AEPRecord to this store (following the existing persistence
   * convention in `@wasmagent/aep`).
   */
  store?: EvidenceStore;
}

/**
 * Ledger — durable evidence ledger with per-record signing and hash-chaining.
 *
 * The Ledger wraps fully-signed `AEPRecord`s (produced by `AEPEmitter` or
 * equivalent) and adds:
 * - A monotonically increasing `seq` number.
 * - A `prevHash` chain linking each record to its predecessor via SHA-256.
 * - A `hash` field for efficient chain verification.
 *
 * Records are stored in-memory and optionally streamed to an `EvidenceStore`
 * for durable persistence (file, database, etc.).
 *
 * ## Key model
 *
 * The Ledger does not perform signing itself. Signing is the responsibility
 * of the caller (typically via `AEPEmitter` with a `LocalEd25519Signer` or
 * KMS adapter). The Ledger accepts pre-signed `AEPRecord`s and verifies
 * their signature structure is present. For production use, pass a KMS-backed
 * signer to the emitter:
 *
 * ```ts
 * // Example: emit a signed record and append it to the ledger
 * const signer = createLocalSignerFromSeed(seedHex, "key-01");
 * const emitter = new AEPEmitter({ run_id: "run-001", signer });
 * emitter.addAction({ tool_name: "bash", state_changing: true });
 * const signedRecord = await emitter.emit();
 *
 * const ledger = new Ledger();
 * const ledgerRecord = await ledger.append(signedRecord);
 * // ledgerRecord.seq === 0, ledgerRecord.prevHash === ""
 * ```
 *
 * ## Thread safety
 *
 * The in-memory record array is not protected against concurrent access.
 * In single-threaded Node.js this is fine. For concurrent environments,
 * use an `EvidenceStore` with serialized appends (like
 * `FilesystemEvidenceStore`) as the source of truth.
 */
export class Ledger {
  #records: LedgerRecord[] = [];
  readonly #store: EvidenceStore | undefined;

  constructor(opts: LedgerOptions = {}) {
    this.#store = opts.store;
  }

  /**
   * Append a pre-signed AEPRecord to the ledger.
   *
   * Steps:
   * 1. Validate that the record carries a signature.
   * 2. Assign the next monotonically increasing `seq`.
   * 3. Set `prevHash` from the last stored ledger record (or genesis sentinel).
   * 4. Compute `hash` of this ledger record.
   * 5. Store the `LedgerRecord` in memory.
   * 6. Optionally persist the `AEPRecord` to the backing `EvidenceStore`.
   *
   * @param record - A fully-signed `AEPRecord`.
   * @returns The stored `LedgerRecord` with `seq`, `prevHash`, and `hash` populated.
   * @throws {Error} If the record has no signature block.
   */
  async append(record: AEPRecord): Promise<LedgerRecord> {
    if (!record.signature) {
      throw new Error("Ledger.append() requires a signed AEPRecord (signature field is missing)");
    }

    const seq = this.#records.length;
    const prevHash = seq === 0 ? GENESIS_PREV_HASH : (this.#records[seq - 1]?.hash ?? "");

    const ledgerRecord: LedgerRecord = {
      seq,
      prevHash,
      record,
      hash: "", // placeholder — computed below
    };
    ledgerRecord.hash = hashLedgerRecord(ledgerRecord);

    this.#records.push(ledgerRecord);

    if (this.#store) {
      await this.#store.append(record);
    }

    return ledgerRecord;
  }

  /**
   * Return all stored ledger records in insertion order.
   */
  get records(): ReadonlyArray<LedgerRecord> {
    return this.#records;
  }

  /**
   * Return the total number of stored ledger records.
   */
  get size(): number {
    return this.#records.length;
  }

  /**
   * Return the last stored ledger record, or `undefined` if the ledger is empty.
   */
  get last(): LedgerRecord | undefined {
    return this.#records[this.#records.length - 1];
  }
}
