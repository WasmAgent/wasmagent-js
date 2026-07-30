import { createHash } from "node:crypto";
import { canonicalBytes } from "./canonical.js";
import type { AEPRecord, ActionEvidence } from "./types.js";

/**
 * evidenceCompressor.ts — auditable summaries and cryptographic fingerprints
 * from long evidence chains (Milestone 7, #272).
 *
 * An {@link EvidenceCompressor} reduces a potentially long sequence of
 * {@link AEPRecord}s into a compact {@link CompressedChainSummary} that:
 *
 * 1. **Preserves chain integrity** — a SHA-256 Merkle-like fingerprint over all
 *    record hashes (computed from canonical bytes, stripped of signature) lets
 *    any verifier confirm that the original records have not been altered,
 *    reordered, or silently dropped.
 * 2. **Enables fast verification** — `verifyChainFingerprint` recomputes the
 *    fingerprint from a set of records and checks it against the summary,
 *    answering "is this chain intact?" without deserialising every field.
 * 3. **Generates auditable summaries** — tool-call rollups, side-effect
 *    distributions, budget totals, decision stats, and a time range give
 *    auditors a human-readable snapshot without requiring access to the
 *    original records.
 *
 * ## Design
 *
 * The compressor is stateless: `compress()` is a pure function that takes an
 * array of records and returns a {@link CompressedChainSummary}. There is no
 * mutable internal state, making it safe to share and call from any context.
 *
 * The fingerprint algorithm mirrors the chain-hash approach used by
 * {@link Ledger} — each record is hashed via `canonicalBytes` (signature
 * stripped), and the per-record hashes are concatenated and SHA-256'd to form
 * the chain fingerprint. This makes the fingerprint order-sensitive.
 *
 * @example
 * ```ts
 * import { EvidenceCompressor } from "@wasmagent/aep";
 *
 * const compressor = new EvidenceCompressor();
 * const summary = compressor.compress(records);
 *
 * // Fast verification: does the chain match what we compressed?
 * const ok = EvidenceCompressor.verifyChainFingerprint(records, summary.chainFingerprint);
 * // ok === true (unless records were tampered with)
 *
 * // Archive the summary; discard originals after confirming fingerprint.
 * await archiveSummary(summary);
 * ```
 */

/**
 * Per-tool aggregated statistics within a compressed chain.
 * Groups all invocations of one tool across every record in the chain.
 */
export interface CompressedToolStats {
  /** Name of the tool. */
  readonly tool_name: string;
  /** Total invocations of this tool across the compressed chain. */
  readonly total_calls: number;
  /** How many of those invocations were state-changing. */
  readonly state_changing_calls: number;
  /**
   * Distribution of `side_effect_class` values across invocations.
   * Key: side_effect_class string, value: count.
   */
  readonly side_effect_distribution: Readonly<Record<string, number>>;
  /**
   * Distribution of outcome labels across invocations.
   * Key: outcome string, value: count. Absent outcomes are not counted.
   */
  readonly outcome_distribution: Readonly<Record<string, number>>;
}

/**
 * Summary of {@link CapabilityDecision}s across the compressed chain.
 */
export interface CompressedDecisionStats {
  /** Total capability decisions across all records. */
  readonly total: number;
  /** Count of "allow" decisions. */
  readonly allowed: number;
  /** Count of "deny" decisions. */
  readonly denied: number;
  /** Count of "ask_user" decisions. */
  readonly asked_user: number;
  /** Count of "dry_run" decisions. */
  readonly dry_run: number;
}

/**
 * Aggregated budget totals across the compressed chain.
 * Each field is the sum of `spent` values for that budget dimension.
 * Dimensions not present in any record are omitted.
 */
export interface CompressedBudgetTotals {
  readonly tokens_spent?: number;
  readonly tool_calls_spent?: number;
  readonly risk_spent?: number;
  readonly retries_spent?: number;
  readonly human_approvals_spent?: number;
}

/**
 * The result of compressing a chain of {@link AEPRecord}s.
 *
 * Contains all information needed to:
 * - Verify chain integrity via `chainFingerprint`.
 * - Audit the chain's activity without reading original records.
 * - Resume a chain by linking a new record to `lastRecordHash`.
 */
export interface CompressedChainSummary {
  /**
   * SHA-256 hex digest of the concatenated per-record canonical hashes
   * (in order, signature stripped). Tamper-evident: any reorder, insertion,
   * deletion, or content change invalidates this fingerprint.
   */
  readonly chainFingerprint: string;

  /**
   * SHA-256 hex digest of the first record's canonical bytes (no signature).
   * Anchors the chain's genesis point.
   */
  readonly firstRecordHash: string;

  /**
   * SHA-256 hex digest of the last record's canonical bytes (no signature).
   * Can be used as `prev_record_hash` for the next record in the chain.
   */
  readonly lastRecordHash: string;

  /** `prev_record_hash` of the first record in the compressed chain (null for genesis). */
  readonly chainPrevHash: string | null;

  /** Number of records in this compressed chain. */
  readonly recordCount: number;

  /** Earliest `created_at_ms` across the compressed records. */
  readonly startedAtMs: number;

  /** Latest `created_at_ms` across the compressed records. */
  readonly endedAtMs: number;

  /** Distinct `run_id` values that appear in the compressed chain. */
  readonly runIds: readonly string[];

  /** Per-tool aggregated statistics. */
  readonly toolStats: readonly CompressedToolStats[];

  /** Capability-decision statistics. */
  readonly decisionStats: CompressedDecisionStats;

  /** Aggregated budget totals. */
  readonly budgetTotals: CompressedBudgetTotals;

  /** Total {@link ActionEvidence} records across all compressed records. */
  readonly totalActions: number;

  /** Unix timestamp (ms) at which this summary was produced. */
  readonly compressedAtMs: number;

  /**
   * Optional human-readable label for this compressed range
   * (supplied via {@link CompressorOptions.label}).
   */
  readonly label?: string;
}

/** Options for {@link EvidenceCompressor.compress}. */
export interface CompressOptions {
  /**
   * Optional human-readable label to embed in the summary
   * (e.g. "session-2025-q1", "replay-run-42").
   */
  label?: string;
  /**
   * Override the `compressedAtMs` timestamp (useful for deterministic tests).
   * Defaults to `Date.now()`.
   */
  nowMs?: number;
}

/**
 * EvidenceCompressor — reduces a long evidence chain to an auditable summary
 * with a cryptographic integrity fingerprint.
 *
 * The compressor is stateless; all work happens inside {@link compress}.
 * The static helper {@link verifyChainFingerprint} re-derives the fingerprint
 * from a set of records so callers can confirm integrity without this class.
 */
export class EvidenceCompressor {
  /**
   * Compress an ordered array of {@link AEPRecord}s into a
   * {@link CompressedChainSummary}.
   *
   * @param records - The chain to compress. Must contain at least one record.
   * @param options - Optional label and timestamp override.
   * @throws {RangeError} if `records` is empty.
   */
  compress(records: readonly AEPRecord[], options: CompressOptions = {}): CompressedChainSummary {
    if (records.length === 0) {
      throw new RangeError("EvidenceCompressor.compress: records array must not be empty");
    }

    const nowMs = options.nowMs ?? Date.now();

    // --- per-record hashes & chain fingerprint ---
    const perRecordHashes: string[] = [];
    for (const record of records) {
      const hash = hashRecord(record);
      perRecordHashes.push(hash);
    }
    const chainFingerprint = buildChainFingerprint(perRecordHashes);

    const firstRecord = records[0]!;
    const lastRecord = records[records.length - 1]!;

    // --- tool stats ---
    const toolMap = new Map<string, {
      total_calls: number;
      state_changing_calls: number;
      side_effect_distribution: Record<string, number>;
      outcome_distribution: Record<string, number>;
    }>();

    let totalActions = 0;
    let startedAtMs = firstRecord.created_at_ms;
    let endedAtMs = lastRecord.created_at_ms;
    const runIdSet = new Set<string>();

    // --- decision stats ---
    let decAllow = 0;
    let decDeny = 0;
    let decAsk = 0;
    let decDry = 0;

    // --- budget totals ---
    let tokensSpent: number | undefined;
    let toolCallsSpent: number | undefined;
    let riskSpent: number | undefined;
    let retriesSpent: number | undefined;
    let humanApprovalsSpent: number | undefined;

    for (const record of records) {
      runIdSet.add(record.run_id);

      if (record.created_at_ms < startedAtMs) startedAtMs = record.created_at_ms;
      if (record.created_at_ms > endedAtMs) endedAtMs = record.created_at_ms;

      totalActions += record.actions.length;

      // aggregate tool stats
      for (const action of record.actions) {
        let entry = toolMap.get(action.tool_name);
        if (!entry) {
          entry = {
            total_calls: 0,
            state_changing_calls: 0,
            side_effect_distribution: {},
            outcome_distribution: {},
          };
          toolMap.set(action.tool_name, entry);
        }
        entry.total_calls++;
        if (action.state_changing) entry.state_changing_calls++;
        const sec = action.side_effect_class ?? "unknown";
        entry.side_effect_distribution[sec] = (entry.side_effect_distribution[sec] ?? 0) + 1;
        if (action.outcome != null) {
          entry.outcome_distribution[action.outcome] =
            (entry.outcome_distribution[action.outcome] ?? 0) + 1;
        }
      }

      // aggregate capability decisions
      for (const dec of record.capability_decisions) {
        switch (dec.decision) {
          case "allow": decAllow++; break;
          case "deny": decDeny++; break;
          case "ask_user": decAsk++; break;
          case "dry_run": decDry++; break;
        }
      }

      // aggregate budget
      const bl = record.budget_ledger;
      if (bl) {
        if (bl.token_budget) {
          tokensSpent = (tokensSpent ?? 0) + bl.token_budget.spent;
        }
        if (bl.tool_budget) {
          toolCallsSpent = (toolCallsSpent ?? 0) + bl.tool_budget.spent;
        }
        if (bl.risk_budget) {
          riskSpent = (riskSpent ?? 0) + bl.risk_budget.spent;
        }
        if (bl.retry_budget) {
          retriesSpent = (retriesSpent ?? 0) + bl.retry_budget.spent;
        }
        if (bl.human_approval_budget) {
          humanApprovalsSpent = (humanApprovalsSpent ?? 0) + bl.human_approval_budget.spent;
        }
      }
    }

    const toolStats: CompressedToolStats[] = Array.from(toolMap.entries()).map(
      ([tool_name, s]) => ({
        tool_name,
        total_calls: s.total_calls,
        state_changing_calls: s.state_changing_calls,
        side_effect_distribution: { ...s.side_effect_distribution },
        outcome_distribution: { ...s.outcome_distribution },
      })
    );

    const decisionStats: CompressedDecisionStats = {
      total: decAllow + decDeny + decAsk + decDry,
      allowed: decAllow,
      denied: decDeny,
      asked_user: decAsk,
      dry_run: decDry,
    };

    const budgetTotals: CompressedBudgetTotals = {};
    if (tokensSpent !== undefined) (budgetTotals as Record<string, number>).tokens_spent = tokensSpent;
    if (toolCallsSpent !== undefined) (budgetTotals as Record<string, number>).tool_calls_spent = toolCallsSpent;
    if (riskSpent !== undefined) (budgetTotals as Record<string, number>).risk_spent = riskSpent;
    if (retriesSpent !== undefined) (budgetTotals as Record<string, number>).retries_spent = retriesSpent;
    if (humanApprovalsSpent !== undefined) (budgetTotals as Record<string, number>).human_approvals_spent = humanApprovalsSpent;

    const summary: CompressedChainSummary = {
      chainFingerprint,
      firstRecordHash: perRecordHashes[0]!,
      lastRecordHash: perRecordHashes[perRecordHashes.length - 1]!,
      chainPrevHash: firstRecord.prev_record_hash ?? null,
      recordCount: records.length,
      startedAtMs,
      endedAtMs,
      runIds: Array.from(runIdSet),
      toolStats,
      decisionStats,
      budgetTotals,
      totalActions,
      compressedAtMs: nowMs,
    };
    if (options.label !== undefined) {
      (summary as { label?: string }).label = options.label;
    }
    return summary;
  }

  /**
   * Verify that a set of records matches a previously computed chain fingerprint.
   *
   * Re-derives the fingerprint from `records` (in the order given) and compares
   * it to `expectedFingerprint`. Returns `true` if they match.
   *
   * @param records - The records to check (must be in the same order as when compressed).
   * @param expectedFingerprint - The `chainFingerprint` from a {@link CompressedChainSummary}.
   */
  static verifyChainFingerprint(
    records: readonly AEPRecord[],
    expectedFingerprint: string
  ): boolean {
    if (records.length === 0) return false;
    const hashes = records.map(hashRecord);
    return buildChainFingerprint(hashes) === expectedFingerprint;
  }
}

/**
 * Compute the SHA-256 hex hash of a single record's canonical bytes
 * (signature and dsse_envelope stripped).
 */
function hashRecord(record: AEPRecord): string {
  const { signature: _sig, dsse_envelope: _dsse, ...unsigned } = record;
  const bytes = canonicalBytes(unsigned);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Combine an ordered list of per-record hex hashes into a single chain
 * fingerprint by concatenating the hashes (as bytes) and SHA-256 hashing
 * the result. Order-sensitive: any permutation changes the fingerprint.
 */
function buildChainFingerprint(perRecordHashes: readonly string[]): string {
  const h = createHash("sha256");
  for (const hex of perRecordHashes) {
    h.update(Buffer.from(hex, "hex"));
  }
  return h.digest("hex");
}
