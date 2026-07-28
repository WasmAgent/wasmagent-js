import { createHash } from "node:crypto";
import { canonicalBytes } from "./canonical.js";
import type { EvidenceStore } from "./evidenceStore.js";
import type { AEPRecord } from "./types.js";

/**
 * evidenceMirror.ts — bidirectional sync between a local EvidenceStore and a
 * remote evidence backend (Milestone 6).
 *
 * An `EvidenceMirror` reconciles a local {@link EvidenceStore} with a remote
 * {@link RemoteEvidenceBackend} so that both sides converge on the same set of
 * AEP records. The remote backend is an intentionally narrow content-addressable
 * key/value interface; concrete adapters for S3, IPFS, and PostgreSQL each map
 * the four operations onto their native primitives:
 *
 * | Operation | S3                          | IPFS                 | PostgreSQL                      |
 * |-----------|-----------------------------|----------------------|---------------------------------|
 * | `list`    | `ListObjectsV2`             | pin ls / index query | `SELECT key FROM evidence`      |
 * | `get`     | `GetObject`                 | block/cat by CID     | `SELECT ... WHERE key = $1`     |
 * | `put`     | `PutObject`                 | add + pin            | `INSERT ... ON CONFLICT ...`    |
 * | `delete`  | `DeleteObject`              | unpin (gc)           | `DELETE WHERE key = $1`         |
 *
 * ## Conflict model
 *
 * Records are identified by a stable `key` computed from the record itself
 * (see {@link EvidenceMirrorOptions.keyOf}). The default key is the record's
 * content digest, which is collision-free: two byte-identical records always
 * share a key, so the default configuration **never conflicts** — sync is a
 * pure set-union.
 *
 * Conflicts arise only when a caller supplies a key function that can map two
 * *different* records to the same slot (for example, keying by `run_id` so the
 * mirror tracks one canonical record per run). When the local and remote sides
 * hold different records under the same key, the configured
 * {@link EvidenceMirrorOptions.conflictResolver | conflict resolver} decides
 * which side wins. Built-in strategies cover the common cases; a custom function
 * handles domain-specific policy.
 *
 * The mirror is **idempotent**: once both sides have converged, repeated
 * `sync()` calls perform no appends or puts and report zero conflicts.
 */

/** A conflict between a local and a remote record sharing the same key. */
export interface RecordConflict {
  /** The shared key (produced by the configured `keyOf`). */
  key: string;
  /** The local record under that key. */
  local: AEPRecord;
  /** The remote record under that key. */
  remote: AEPRecord;
}

/** Which side's record wins a conflict. */
export type ConflictWinner = "local" | "remote";

/**
 * A pluggable conflict resolver. Return `"local"` to keep the local record as
 * canonical (overwriting the remote on push, ignoring the remote on pull), or
 * `"remote"` for the opposite. Throw to abort the sync (e.g. for manual review).
 */
export type ConflictResolverFn = (conflict: RecordConflict) => ConflictWinner;

/**
 * Built-in conflict resolution strategies.
 *
 * - `"last-writer-wins"` (default): the record with the greater `created_at_ms`
 *   wins; ties break to `"local"` for determinism.
 * - `"prefer-local"`: the local record always wins.
 * - `"prefer-remote"`: the remote record always wins.
 * - `"fail"`: any conflict throws {@link EvidenceMirrorConflictError}, surfacing
 *   the divergence for human resolution.
 */
export type ConflictResolution = "last-writer-wins" | "prefer-local" | "prefer-remote" | "fail";

/**
 * Content-addressable remote evidence backend.
 *
 * Backends identify records by a caller-chosen string key (see
 * {@link contentDigestKeyOf}) and store the full {@link AEPRecord}. The mirror
 * computes keys centrally and passes them in, so a backend is a pure KV store
 * over `AEPRecord` values.
 */
export interface RemoteEvidenceBackend {
  /** Human-readable backend id (e.g. `"s3"`, `"ipfs"`, `"postgres"`) for logs/metadata. */
  readonly kind: string;
  /** Return the keys of every record currently stored remotely. */
  list(): Promise<string[]>;
  /** Return the record stored under `key`, or `undefined` if absent. */
  get(key: string): Promise<AEPRecord | undefined>;
  /** Store `record` under `key`, overwriting any prior content for that key. */
  put(key: string, record: AEPRecord): Promise<void>;
  /** Remove the record stored under `key`, if any. */
  delete(key: string): Promise<void>;
}

/**
 * Default keying: the SHA-256 content digest over the canonical bytes of the
 * record with `signature` and `dsse_envelope` stripped — the same projection
 * used by `verifyAEPChain` and the export-adapter record digests.
 *
 * Two byte-identical records share a key, so this keying is collision-free and
 * the default mirror configuration never produces conflicts.
 */
export function contentDigestKeyOf(record: AEPRecord): string {
  const { signature: _sig, dsse_envelope: _dsse, ...unsigned } = record;
  return createHash("sha256").update(canonicalBytes(unsigned)).digest("hex");
}

/** Thrown when `conflictResolution: "fail"` encounters a conflicting key. */
export class EvidenceMirrorConflictError extends Error {
  /** The conflict that triggered the error. */
  readonly conflict: RecordConflict;
  constructor(conflict: RecordConflict) {
    super(
      `EvidenceMirror conflict at key "${conflict.key}" (run_id=${conflict.local.run_id}) with conflictResolution="fail"`
    );
    this.name = "EvidenceMirrorConflictError";
    this.conflict = conflict;
  }
}

/** Per-phase record of one conflict resolution decision. */
export interface ConflictResolutionEntry {
  key: string;
  winner: ConflictWinner;
  /** Which one-way pass observed the conflict. */
  phase: "push" | "pull";
}

/** Outcome of a {@link EvidenceMirror.push} / {@link EvidenceMirror.pull} / {@link EvidenceMirror.sync} pass. */
export interface SyncResult {
  /** Records copied from the local store to the remote backend. */
  pushed: number;
  /** Records appended from the remote backend to the local store. */
  pulled: number;
  /** Keys where the local and remote records differed. */
  conflicts: number;
  /** Keys that were already in sync and required no action. */
  skipped: number;
  /** One entry per conflict resolution decision, in encounter order. */
  resolutions: ConflictResolutionEntry[];
}

/** Options for constructing an {@link EvidenceMirror}. */
export interface EvidenceMirrorOptions {
  /** The local store to mirror. */
  local: EvidenceStore;
  /** The remote backend to sync against. */
  remote: RemoteEvidenceBackend;
  /**
   * Compute the stable key under which a record is identified on both sides.
   * Defaults to {@link contentDigestKeyOf}. Supply a custom function only when
   * you want position/logical-slot keying that can intentionally collide.
   */
  keyOf?: (record: AEPRecord) => string;
  /**
   * Conflict resolution strategy or custom resolver function. Defaults to
   * `"last-writer-wins"`.
   */
  conflictResolver?: ConflictResolution | ConflictResolverFn;
}

function asResolverFn(opt?: ConflictResolution | ConflictResolverFn): ConflictResolverFn {
  if (typeof opt === "function") return opt;
  switch (opt ?? "last-writer-wins") {
    case "prefer-local":
      return () => "local";
    case "prefer-remote":
      return () => "remote";
    case "fail":
      return (conflict) => {
        throw new EvidenceMirrorConflictError(conflict);
      };
    default:
      // "last-writer-wins" (the default strategy, also reached when opt is
      // undefined via the `??` above). Ties on created_at_ms break to "local"
      // so the outcome is deterministic.
      return (conflict) =>
        conflict.local.created_at_ms >= conflict.remote.created_at_ms ? "local" : "remote";
  }
}

/** SHA-256 fingerprint over the FULL canonical record (signature included). */
function recordFingerprint(record: AEPRecord): string {
  return createHash("sha256").update(canonicalBytes(record)).digest("hex");
}

/** Two records are "the same evidence" iff their full canonical bytes match. */
function recordsEqual(a: AEPRecord, b: AEPRecord): boolean {
  return recordFingerprint(a) === recordFingerprint(b);
}

/**
 * EvidenceMirror — bidirectional sync between a local {@link EvidenceStore} and
 * a remote {@link RemoteEvidenceBackend}.
 *
 * Use {@link sync} for bidirectional reconciliation, or {@link push} / {@link pull}
 * for one-way copies. All methods are idempotent.
 *
 * @example
 * ```ts
 * import {
 *   EvidenceMirror,
 *   InMemoryEvidenceStore,
 *   InMemoryRemoteEvidenceBackend,
 * } from "@wasmagent/aep";
 *
 * const local = new InMemoryEvidenceStore();
 * const remote = new InMemoryRemoteEvidenceBackend("s3");
 * const mirror = new EvidenceMirror({ local, remote });
 *
 * // after the agent run appends records to `local`...
 * const result = await mirror.sync();
 * console.log(`pushed ${result.pushed}, pulled ${result.pulled}, conflicts ${result.conflicts}`);
 * ```
 */
export class EvidenceMirror {
  readonly #local: EvidenceStore;
  readonly #remote: RemoteEvidenceBackend;
  readonly #keyOf: (record: AEPRecord) => string;
  readonly #resolve: ConflictResolverFn;

  constructor(options: EvidenceMirrorOptions) {
    this.#local = options.local;
    this.#remote = options.remote;
    this.#keyOf = options.keyOf ?? contentDigestKeyOf;
    this.#resolve = asResolverFn(options.conflictResolver);
  }

  /**
   * Push local → remote. For each local record (one representative per key):
   * if the remote lacks the key, store it; if the remote holds an identical
   * record, skip; otherwise resolve the conflict and overwrite the remote only
   * when the local record wins.
   */
  async push(): Promise<SyncResult> {
    const result: SyncResult = {
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      skipped: 0,
      resolutions: [],
    };
    const localRecords = await this.#local.query();
    const seenKeys = new Set<string>();
    for (const localRecord of localRecords) {
      const key = this.#keyOf(localRecord);
      // One representative per key on the local side: the first occurrence wins
      // for push purposes. (The default content-digest key never repeats.)
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const remoteRecord = await this.#remote.get(key);
      if (remoteRecord === undefined) {
        await this.#remote.put(key, localRecord);
        result.pushed++;
        continue;
      }
      if (recordsEqual(localRecord, remoteRecord)) {
        result.skipped++;
        continue;
      }
      result.conflicts++;
      const winner = this.#resolve({ key, local: localRecord, remote: remoteRecord });
      result.resolutions.push({ key, winner, phase: "push" });
      if (winner === "local") {
        await this.#remote.put(key, localRecord);
        result.pushed++;
      } else {
        // Remote keeps its record; nothing to push.
        result.skipped++;
      }
    }
    return result;
  }

  /**
   * Pull remote → local. For each remote key: if the local store lacks it,
   * append the remote record; if the local store already holds an identical
   * record under that key, skip; otherwise resolve the conflict and append the
   * remote record only when it wins.
   *
   * A key may map to several local records (e.g. after a prior conflict
   * resolution appended the winner), so "already present" is decided by content
   * match against any local record sharing the key — this keeps repeated pulls
   * idempotent.
   */
  async pull(): Promise<SyncResult> {
    const result: SyncResult = {
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      skipped: 0,
      resolutions: [],
    };
    const localRecords = await this.#local.query();
    const localByKey = new Map<string, AEPRecord[]>();
    for (const record of localRecords) {
      const key = this.#keyOf(record);
      const bucket = localByKey.get(key);
      if (bucket) {
        bucket.push(record);
      } else {
        localByKey.set(key, [record]);
      }
    }

    const remoteKeys = await this.#remote.list();
    for (const key of remoteKeys) {
      const remoteRecord = await this.#remote.get(key);
      if (remoteRecord === undefined) continue;

      const localBucket = localByKey.get(key);
      if (localBucket === undefined) {
        await this.#local.append(remoteRecord);
        localByKey.set(key, [remoteRecord]);
        result.pulled++;
        continue;
      }

      // Already present locally (any record under this key with equal content)?
      if (localBucket.some((r) => recordsEqual(r, remoteRecord))) {
        result.skipped++;
        continue;
      }

      // Same key, different content → conflict against the local representative.
      const localRep = localBucket[0];
      if (!localRep) continue;
      result.conflicts++;
      const winner = this.#resolve({ key, local: localRep, remote: remoteRecord });
      result.resolutions.push({ key, winner, phase: "pull" });
      if (winner === "remote") {
        await this.#local.append(remoteRecord);
        localBucket.push(remoteRecord);
        result.pulled++;
      } else {
        // Local keeps its record; nothing to pull.
        result.skipped++;
      }
    }
    return result;
  }

  /**
   * Bidirectional sync: run {@link push} then {@link pull} and merge their
   * results. After a successful sync both sides hold the same set of records
   * (per the conflict policy), and a second `sync()` is a no-op.
   */
  async sync(): Promise<SyncResult> {
    const pushResult = await this.push();
    const pullResult = await this.pull();
    return {
      pushed: pushResult.pushed,
      pulled: pullResult.pulled,
      conflicts: pushResult.conflicts + pullResult.conflicts,
      skipped: pushResult.skipped + pullResult.skipped,
      resolutions: [...pushResult.resolutions, ...pullResult.resolutions],
    };
  }
}

/**
 * Reference in-memory implementation of {@link RemoteEvidenceBackend}.
 *
 * Useful for tests, single-process demos, and as a behavioural spec for real
 * S3/IPFS/PostgreSQL adapters. The optional `kind` argument lets callers label
 * the backend (e.g. `"s3"`) for logs and metadata without affecting behaviour.
 */
export class InMemoryRemoteEvidenceBackend implements RemoteEvidenceBackend {
  readonly kind: string;
  readonly #store = new Map<string, AEPRecord>();

  constructor(kind = "memory") {
    this.kind = kind;
  }

  async list(): Promise<string[]> {
    return [...this.#store.keys()];
  }

  async get(key: string): Promise<AEPRecord | undefined> {
    return this.#store.get(key);
  }

  async put(key: string, record: AEPRecord): Promise<void> {
    this.#store.set(key, record);
  }

  async delete(key: string): Promise<void> {
    this.#store.delete(key);
  }
}
