/**
 * state-recovery.ts — reconstruct agent runtime state from historical AEP
 * evidence chains.
 *
 * Milestone 7 — Distributed Evidence Coordination & Recovery.
 *
 * After a crash or process restart, an agent's in-memory state is gone, but
 * the durable AEP evidence chain it emitted (one signed, hash-linked record per
 * emitted step) survives in an `EvidenceStore`. {@link StateRecovery} walks that
 * chain in order and reconstructs:
 *
 *   - the original task,
 *   - the model + tool set the run used,
 *   - an ordered `Step[]` timeline (each tool call → a `ToolUseStep`) ready to
 *     feed back into a `MessageAssembler` via `restoreFromSnapshot()`,
 *   - the full causality graph (`action_id` → `parent_action_id` /
 *     `causal_chain_id`),
 *   - chain-integrity metadata, so the caller knows whether the reconstruction
 *     can be trusted or whether the chain was truncated / tampered.
 *
 * Architectural note — this module mirrors `AgentGroup`'s relationship to the
 * evidence layer: it imports `@wasmagent/aep` **types only** (no runtime
 * dependency, so `@wasmagent/core` consumers that never opt into evidence do
 * not pull `@wasmagent/aep`). The store is consumed via a structural
 * {@link RecoveryEvidenceSource} (duck-compatible with `EvidenceStore`), and
 * full cryptographic chain verification is delegated to an optional
 * caller-supplied verifier (e.g. aep's `verifyAEPChain`). The default fast path
 * is a lightweight structural check; the authoritative symbolic verifier lives
 * in the `symkernel` repo.
 */

import type { ActionEvidence, AEPRecord } from "@wasmagent/aep";
import type { AgentSnapshot } from "./checkpoint/index.js";
import type { Step, ToolUseStep } from "./types/events.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** One node in the recovered causality graph. */
export interface CausalLink {
  /** Stable action id from the evidence (maps to `ToolUseStep.toolCallId`). */
  actionId: string;
  toolName: string;
  /** Parent action id, recording which action caused this one. */
  parentActionId?: string;
  /** Causal-chain id grouping actions that share a causality strand. */
  causalChainId?: string;
  /** Evidence timestamp (ms) for this action. */
  timestampMs: number;
  /** Index of the originating record within the consumed chain. */
  recordIndex: number;
}

/** Chain-integrity outcome for the consumed records. */
export interface RecoveryChainIntegrity {
  valid: boolean;
  /** Index of the first record where the chain breaks, when invalid. */
  brokenAt?: number;
  /** Human-readable reason when invalid. */
  reason?: string;
}

/** Reconstructed runtime state, ready to resume an agent. */
export interface RecoveredState {
  /** The `run_id` the recovery targeted. */
  runId: string;
  /** Reconstructed trace id (first record carrying one), if any. */
  traceId?: string;
  /** Parent trace id (first record carrying one), if any. Null is meaningful. */
  parentTraceId?: string | null;
  /** Original task text recovered from the chain (best-effort). */
  task: string;
  /** Ordered runtime timeline reconstructed from evidence actions. */
  steps: Step[];
  /** Best-effort recovered model id (first record's `model_id`). */
  model?: string;
  /** Sorted, de-duplicated set of tool names observed in the evidence. */
  tools: string[];
  /** Full causality graph, one entry per reconstructed action. */
  causalChain: CausalLink[];
  /** Number of distinct records consumed. */
  recordCount: number;
  /** Number of actions reconstructed. */
  actionCount: number;
  /** Time range `[start, end]` ms covered by the evidence, when non-empty. */
  timeRangeMs?: { start: number; end: number };
  /** Integrity of the consumed evidence chain. */
  chainIntegrity: RecoveryChainIntegrity;
}

/**
 * Structural view of an evidence store — duck-compatible with
 * `@wasmagent/aep`'s `EvidenceStore`, so an `InMemoryEvidenceStore` or
 * `FilesystemEvidenceStore` can be passed directly. Declared against the aep
 * `AEPRecord` type so this module has no runtime dependency on `@wasmagent/aep`.
 */
export interface RecoveryEvidenceSource {
  /** Return all records for a run, oldest first (insertion / chain order). */
  getByRunId(runId: string): AEPRecord[] | Promise<AEPRecord[]>;
}

/**
 * Caller-supplied chain verifier, structurally compatible with aep's
 * `verifyAEPChain`. When provided, it replaces the lightweight structural fast
 * path with full hash-chain (and, if the caller wraps it, signature)
 * verification.
 */
export type ChainVerifier = (records: AEPRecord[]) => { valid: boolean; brokenAt?: number };

export interface StateRecoveryOptions {
  /** Trace-id filter — records carrying a different `trace_id` are skipped. */
  traceId?: string;
  /** Override the recovered task text (highest priority). */
  task?: string;
  /** Override the recovered model id. */
  model?: string;
  /**
   * Optional full chain verifier (e.g. aep's `verifyAEPChain`). When omitted, a
   * lightweight structural check (ordering + `prev_record_hash` consistency) is
   * used as a fast path.
   */
  verifyChain?: ChainVerifier;
  /**
   * When `true` (default), `recover()` / `recoverFromRecords()` throw if the
   * chain is broken. Set `false` to still reconstruct state from a broken or
   * incomplete chain (the typical crash-recovery case where the tail may be
   * truncated); the result's `chainIntegrity.valid` then reflects the break.
   */
  throwOnBrokenChain?: boolean;
}

// ── StateRecovery ─────────────────────────────────────────────────────────────

/**
 * Reconstruct agent runtime state from historical AEP evidence chains.
 *
 * @example
 * ```ts
 * import { StateRecovery, restoreFromSnapshot } from "@wasmagent/core";
 * import { InMemoryEvidenceStore } from "@wasmagent/aep";
 *
 * const store = new InMemoryEvidenceStore();
 * // … agent emitted evidence into `store`, then crashed …
 *
 * const recovery = new StateRecovery();
 * const state = await recovery.recover(store, runId, { throwOnBrokenChain: false });
 * const snapshot = recovery.toSnapshot(state);
 * restoreFromSnapshot(snapshot, assembler); // assembler now holds the timeline
 * ```
 */
export class StateRecovery {
  /**
   * Reconstruct runtime state for a run by reading its evidence chain from a
   * store. Records are consumed in the order the store returns them (oldest
   * first, per the `EvidenceStore.getByRunId` contract).
   */
  async recover(
    source: RecoveryEvidenceSource,
    runId: string,
    options: StateRecoveryOptions = {}
  ): Promise<RecoveredState> {
    const records = await source.getByRunId(runId);
    return this.recoverFromRecords(records, runId, options);
  }

  /**
   * Reconstruct runtime state from an explicit, ordered list of records.
   *
   * Records MUST be in chain order (oldest first) — the same order
   * `EvidenceStore.getByRunId` yields them — so that an optional
   * `verifyAEPChain`-style verifier sees an intact hash chain.
   */
  recoverFromRecords(
    records: AEPRecord[],
    runId: string,
    options: StateRecoveryOptions = {}
  ): RecoveredState {
    const filtered = this.#filter(records, runId, options.traceId);
    const chainIntegrity = this.#verifyChain(filtered, options.verifyChain);
    if (!chainIntegrity.valid && (options.throwOnBrokenChain ?? true)) {
      throw new Error(
        `StateRecovery: evidence chain for run ${runId} is broken` +
          (chainIntegrity.reason ? ` (${chainIntegrity.reason})` : "") +
          (chainIntegrity.brokenAt !== undefined ? ` at record ${chainIntegrity.brokenAt}` : "") +
          ". Pass { throwOnBrokenChain: false } to reconstruct anyway."
      );
    }
    return this.#build(filtered, runId, options, chainIntegrity);
  }

  /**
   * Convert recovered state into an {@link AgentSnapshot} suitable for
   * `restoreFromSnapshot()`. The snapshot's `stepIndex` is the reconstructed
   * step count and `savedAtMs` is the last evidence timestamp (so the resumed
   * run continues from where the chain ended).
   *
   * @param state        Recovered runtime state.
   * @param agentConfig  Optional agent config to attach to the snapshot.
   */
  toSnapshot(state: RecoveredState, agentConfig?: AgentSnapshot["agentConfig"]): AgentSnapshot {
    const snapshot: AgentSnapshot = {
      traceId: state.traceId ?? state.runId,
      task: state.task,
      history: state.steps,
      stepIndex: state.steps.length,
      savedAtMs: state.timeRangeMs?.end ?? Date.now(),
    };
    if (agentConfig) snapshot.agentConfig = agentConfig;
    return snapshot;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  #filter(records: AEPRecord[], runId: string, traceId?: string): AEPRecord[] {
    return records.filter((r) => {
      if (r.run_id !== runId) return false;
      if (traceId !== undefined && r.trace_id !== undefined && r.trace_id !== traceId) {
        return false;
      }
      return true;
    });
  }

  #verifyChain(records: AEPRecord[], verifier?: ChainVerifier): RecoveryChainIntegrity {
    if (records.length === 0) {
      return { valid: true, reason: "empty chain" };
    }
    if (verifier) {
      const result = verifier(records);
      if (result.valid) return { valid: true };
      // exactOptionalPropertyTypes: only set brokenAt when actually defined.
      const integrity: RecoveryChainIntegrity = {
        valid: false,
        reason: "caller verifier rejected chain",
      };
      if (result.brokenAt !== undefined) integrity.brokenAt = result.brokenAt;
      return integrity;
    }
    // Lightweight structural fast path. A real hash check requires the aep
    // canonical serializer; callers that need it pass `verifyAEPChain`.
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      const claimsPrev = record.prev_record_hash != null;
      if (i === 0 && claimsPrev) {
        return { valid: false, brokenAt: i, reason: "first record claims a previous hash" };
      }
      if (i > 0 && !claimsPrev) {
        return {
          valid: false,
          brokenAt: i,
          reason: "missing prev_record_hash mid-chain (truncated or incomplete evidence)",
        };
      }
    }
    return { valid: true };
  }

  #build(
    records: AEPRecord[],
    runId: string,
    options: StateRecoveryOptions,
    chainIntegrity: RecoveryChainIntegrity
  ): RecoveredState {
    const steps: Step[] = [];
    const causalChain: CausalLink[] = [];
    const toolSet = new Set<string>();

    let model: string | undefined;
    let traceId: string | undefined;
    let parentTraceId: string | null | undefined;
    let stepIndex = 0;
    let actionCount = 0;
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;

    records.forEach((record, recordIndex) => {
      if (model === undefined && record.model_id) model = record.model_id;
      if (traceId === undefined && record.trace_id !== undefined) traceId = record.trace_id;
      if (parentTraceId === undefined && record.parent_trace_id !== undefined) {
        parentTraceId = record.parent_trace_id;
      }
      if (record.created_at_ms < start) start = record.created_at_ms;
      if (record.created_at_ms > end) end = record.created_at_ms;

      for (const action of record.actions ?? []) {
        actionCount += 1;
        if (action.tool_name) toolSet.add(action.tool_name);
        stepIndex += 1;

        const step: ToolUseStep = {
          type: "tool_use",
          stepIndex,
          thoughts: "",
          toolCallId: action.action_id,
          toolName: action.tool_name,
          // AEP stores an arguments digest, not the raw args; the resumed agent
          // re-derives inputs from its (restored) message history.
          toolInput: {},
          toolOutput: action.outcome ?? "",
          isError: isActionError(action),
        };
        steps.push(step);

        const link: CausalLink = {
          actionId: action.action_id,
          toolName: action.tool_name,
          timestampMs: action.timestamp_ms,
          recordIndex,
        };
        if (action.parent_action_id) link.parentActionId = action.parent_action_id;
        if (action.causal_chain_id) link.causalChainId = action.causal_chain_id;
        causalChain.push(link);
      }
    });

    const recoveredModel = options.model ?? model;

    return {
      runId,
      task: options.task ?? recoverTask(records),
      steps,
      tools: [...toolSet].sort(),
      causalChain,
      recordCount: records.length,
      actionCount,
      chainIntegrity,
      ...(traceId !== undefined ? { traceId } : {}),
      ...(parentTraceId !== undefined ? { parentTraceId } : {}),
      ...(recoveredModel !== undefined ? { model: recoveredModel } : {}),
      ...(Number.isFinite(start) && Number.isFinite(end) ? { timeRangeMs: { start, end } } : {}),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Recover the original task text from the chain. Looks for an `input_ref`
 * whose URI uses the `task:` (or `prompt:`) scheme and decodes its payload.
 * Returns an empty string when no task is encoded in the evidence; callers can
 * override via `StateRecoveryOptions.task`.
 */
export function recoverTask(records: AEPRecord[]): string {
  for (const record of records) {
    for (const ref of record.input_refs ?? []) {
      const uri = ref?.uri;
      if (typeof uri !== "string") continue;
      const decoded = decodeTaskUri(uri);
      if (decoded !== undefined) return decoded;
    }
  }
  return "";
}

function decodeTaskUri(uri: string): string | undefined {
  for (const scheme of ["task:", "prompt:"]) {
    if (uri.startsWith(scheme)) {
      try {
        return decodeURIComponent(uri.slice(scheme.length));
      } catch {
        return uri.slice(scheme.length);
      }
    }
  }
  return undefined;
}

/** Infer whether an evidence action represents a failed tool call. */
function isActionError(action: ActionEvidence): boolean {
  const outcome = action.outcome;
  if (outcome === "error" || outcome === "failed" || outcome === "failure") return true;
  if (action.exit_code !== undefined && action.exit_code !== 0) return true;
  return false;
}
