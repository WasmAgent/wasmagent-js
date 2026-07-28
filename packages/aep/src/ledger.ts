import { createHash } from "node:crypto";
import { canonicalBytes } from "./canonical.js";
import type { EvidenceStore } from "./evidenceStore.js";
import type { AEPRecord } from "./types.js";

/**
 * Options for {@link Ledger.compact}.
 */
export interface CompactionOptions {
  /**
   * Compact all records with `seq <= upToSeq`.
   * Defaults to `ledger.size - 1` (all records).
   */
  upToSeq?: number;
  /**
   * Minimum number of records required for compaction to proceed.
   * If fewer records are in range, `compact()` throws.
   * Default: 2.
   */
  minRecords?: number;
  /** Optional human-readable label for this compaction (e.g., "session-1-rollup"). */
  label?: string;
}

/**
 * Compressed summary of repetitive tool calls within a compacted range.
 *
 * Instead of storing every individual `ActionEvidence`, repetitive calls to
 * the same tool are rolled up into a single count-based summary.
 */
export interface ToolCallRollup {
  /** The tool name being summarized. */
  tool_name: string;
  /** Total number of invocations of this tool. */
  count: number;
  /** How many of those invocations were state-changing. */
  state_changing_count: number;
  /** Distribution of side_effect_class values across invocations. */
  side_effect_classes: Record<string, number>;
}

/**
 * Result of compacting a range of ledger records.
 *
 * Contains all data needed to:
 * - Verify the cryptographic chain proof of the compacted records.
 * - Understand what was compacted (tool-call summaries, time range, run IDs).
 * - Safely archive the original detailed records.
 */
export interface CompactionResult {
  /** Seq number of the first compacted record. */
  fromSeq: number;
  /** Seq number of the last compacted record. */
  toSeq: number;
  /** Number of original ledger records compacted. */
  recordCount: number;
  /**
   * SHA-256 hex digest of the concatenated hashes of all compacted
   * `LedgerRecord`s. Serves as a Merkle-like proof root — any change
   * to the compacted records (order, content, removal) invalidates this hash.
   */
  proofHash: string;
  /** Hash of the first compacted LedgerRecord. */
  firstRecordHash: string;
  /** prevHash of the first compacted LedgerRecord (genesis sentinel for seq 0). */
  firstRecordPrevHash: string;
  /** Hash of the last compacted LedgerRecord. */
  lastRecordHash: string;
  /** Compressed tool-call summaries from all actions in compacted records. */
  toolRollups: ToolCallRollup[];
  /** Earliest `created_at_ms` across compacted records. */
  startedAtMs: number;
  /** Latest `created_at_ms` across compacted records. */
  endedAtMs: number;
  /** Distinct `run_id` values in compacted records. */
  runIds: string[];
  /** Label provided via {@link CompactionOptions.label}. */
  label?: string;
  /** Timestamp (ms) when this compaction was created. */
  compactedAtMs: number;
}

/**
 * Build compressed tool-call rollups from a sequence of ledger records.
 *
 * Groups actions by `tool_name` and counts invocations, state-changing
 * calls, and side-effect class distributions.
 */
export function buildToolRollups(records: ReadonlyArray<LedgerRecord>): ToolCallRollup[] {
  const map = new Map<string, ToolCallRollup>();

  for (const lr of records) {
    for (const action of lr.record.actions) {
      let entry = map.get(action.tool_name);
      if (!entry) {
        entry = {
          tool_name: action.tool_name,
          count: 0,
          state_changing_count: 0,
          side_effect_classes: {},
        };
        map.set(action.tool_name, entry);
      }
      entry.count++;
      if (action.state_changing) entry.state_changing_count++;
      const sec = action.side_effect_class ?? "unknown";
      entry.side_effect_classes[sec] = (entry.side_effect_classes[sec] ?? 0) + 1;
    }
  }

  return [...map.values()];
}

/**
 * Compute the proof hash for a range of ledger records.
 *
 * The proof hash is SHA-256 of the concatenated hex hashes of each
 * `LedgerRecord`, preserving a Merkle-like proof root that covers
 * the entire chain segment.
 */
export function computeProofHash(records: ReadonlyArray<LedgerRecord>): string {
  const input = records.map((lr) => lr.hash).join("");
  return createHash("sha256").update(input).digest("hex");
}

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

  /**
   * Return ledger records in the range `[fromSeq, toSeq]` (inclusive).
   * Returns an empty array if no records fall within the range.
   */
  getRange(fromSeq: number, toSeq: number): ReadonlyArray<LedgerRecord> {
    return this.#records.filter((lr) => lr.seq >= fromSeq && lr.seq <= toSeq);
  }

  /**
   * Compact a range of ledger records into a verifiable summary.
   *
   * This is an **analytical (read-only)** operation — it does not modify
   * the ledger. The returned `CompactionResult` contains:
   *
   * - A `proofHash` (Merkle-like root of all compacted record hashes)
   *   that can be re-verified later with `verifyCompaction()`.
   * - Chain endpoint metadata (`firstRecordHash`, `lastRecordHash`,
   *   `firstRecordPrevHash`) preserving cryptographic chain continuity.
   * - Compressed `ToolCallRollup` summaries replacing repetitive
   *   individual action payloads.
   *
   * ## Usage pattern for long-running sessions
   *
   * ```ts
   * // After accumulating many records, compact the tail:
   * const compaction = ledger.compact({ upToSeq: 99, label: "session-1" });
   * // Store compactionResult for auditing, then archive records 0..99
   * ```
   *
   * @param options - Compaction configuration.
   * @throws {Error} If the ledger has fewer records than `minRecords` (default 2).
   * @throws {Error} If `upToSeq` is negative.
   */
  compact(options: CompactionOptions = {}): CompactionResult {
    const upToSeq = options.upToSeq ?? (this.#records.length > 0 ? this.#records.length - 1 : -1);
    const minRecords = options.minRecords ?? 2;

    if (upToSeq < 0) {
      throw new Error("Ledger.compact() requires at least one record to compact");
    }

    const compactedRecords = this.#records.filter((lr) => lr.seq <= upToSeq);

    if (compactedRecords.length < minRecords) {
      throw new Error(
        `Ledger.compact(): ${compactedRecords.length} records in range (minimum: ${minRecords})`
      );
    }

    const proofHash = computeProofHash(compactedRecords);
    const toolRollups = buildToolRollups(compactedRecords);

    const timestamps = compactedRecords.map((lr) => lr.record.created_at_ms);
    const startedAtMs = timestamps[0] ?? 0;
    const endedAtMs = timestamps[timestamps.length - 1] ?? 0;

    const runIds = [...new Set(compactedRecords.map((lr) => lr.record.run_id))];

    const firstRecord = compactedRecords[0];
    const lastRecord = compactedRecords[compactedRecords.length - 1];
    if (!firstRecord || !lastRecord) {
      throw new Error("Ledger.compact(): unexpected empty compacted range");
    }

    const result: CompactionResult = {
      fromSeq: firstRecord.seq,
      toSeq: lastRecord.seq,
      recordCount: compactedRecords.length,
      proofHash,
      firstRecordHash: firstRecord.hash,
      firstRecordPrevHash: firstRecord.prevHash,
      lastRecordHash: lastRecord.hash,
      toolRollups,
      startedAtMs,
      endedAtMs,
      runIds,
      compactedAtMs: Date.now(),
    };
    if (options.label !== undefined) {
      result.label = options.label;
    }
    return result;
  }

  /**
   * Verify that a `CompactionResult` matches the current ledger records.
   *
   * Recomputes the proof hash from the actual records and checks:
   * - Record count matches.
   * - Proof hash matches (no records added/removed/reordered).
   * - Chain endpoints match (first/last record hashes, first prevHash).
   *
   * Returns `false` if the compacted records have been tampered with
   * or if the ledger no longer contains the expected records.
   *
   * @param compaction - The `CompactionResult` to verify against the ledger.
   */
  verifyCompaction(compaction: CompactionResult): boolean {
    const compactedRecords = this.#records.filter(
      (lr) => lr.seq >= compaction.fromSeq && lr.seq <= compaction.toSeq
    );

    if (compactedRecords.length !== compaction.recordCount) return false;

    // Recompute proof hash from actual records
    const recomputed = computeProofHash(compactedRecords);
    if (recomputed !== compaction.proofHash) return false;

    // Verify chain endpoints
    if (compactedRecords.length === 0) return false;
    const first = compactedRecords[0];
    const last = compactedRecords[compactedRecords.length - 1];
    if (!first || !last) return false;
    if (first.hash !== compaction.firstRecordHash) return false;
    if (first.prevHash !== compaction.firstRecordPrevHash) return false;
    if (last.hash !== compaction.lastRecordHash) return false;

    return true;
  }
}
