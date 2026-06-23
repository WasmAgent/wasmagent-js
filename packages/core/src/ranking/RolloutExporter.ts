import { createHash } from "node:crypto";
import type { AgentEvent } from "../types/events.js";
import type { RolloutBranchResult } from "../enhancement/RolloutForkRunner.js";
import type { RankedBranch } from "./RolloutRanker.js";

// ── Record types ──────────────────────────────────────────────────────────────
//
// SCHEMA GOVERNANCE: These types are the single source of truth for the
// rollout wire format consumed by evomerge/datafactory/exporter.py.
// Field names use snake_case to match the JSON wire format and Python conventions.
// When changing these types:
//   1. Update packages/core/src/ranking/schemas/rollout-wire.schema.json
//   2. Notify evomerge maintainers to update exporter.py + schema copy
// See docs/schemas/GOVERNANCE.md for the full change process.

export interface DpoRecord {
  prompt: string;
  chosen: string;
  rejected: string;
  tool_call_sequence: AgentEvent[];
  provenance: {
    source: "wasmagent-rollout";
    rollout_id: string;
    chosen_branch: number;
    rejected_branch: number;
    objective_score: { chosen: 0 | 1; rejected: 0 | 1 };
    exported_at_ms: number;
    n_gram_hash: string;
  };
}

export interface PpoRecord {
  prompt: string;
  completion: string;
  reward: number;
  tool_call_sequence: AgentEvent[];
  provenance: {
    source: "wasmagent-rollout";
    rollout_id: string;
    branch_index: number;
    objective_score: 0 | 1;
    exported_at_ms: number;
    n_gram_hash: string;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildBranchMap(branches: RolloutBranchResult[]): Map<number, RolloutBranchResult> {
  const m = new Map<number, RolloutBranchResult>();
  for (const b of branches) m.set(b.branchIndex, b);
  return m;
}

function buildRankedMap(ranked: RankedBranch[]): Map<number, RankedBranch> {
  const m = new Map<number, RankedBranch>();
  for (const r of ranked) m.set(r.branchIndex, r);
  return m;
}

function ngramHash(task: string): string {
  return createHash("sha256").update(task, "utf8").digest("hex").slice(0, 16);
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Produce a single DPO training record from a ranked set of branches.
 * Returns null when fewer than 2 branches exist or chosen/rejected answers are identical.
 */
export function toDpoRecord(
  branches: RolloutBranchResult[],
  ranked: RankedBranch[],
  exportedAtMs: number
): DpoRecord | null {
  if (ranked.length < 2) return null;

  const sorted = [...ranked].sort((a, b) => a.rank - b.rank);
  const chosenRanked = sorted[0]!;
  const rejectedRanked = sorted[sorted.length - 1]!;

  const branchMap = buildBranchMap(branches);
  const chosenBranch = branchMap.get(chosenRanked.branchIndex);
  const rejectedBranch = branchMap.get(rejectedRanked.branchIndex);

  if (!chosenBranch || !rejectedBranch) return null;
  if (chosenBranch.finalAnswer === rejectedBranch.finalAnswer) return null;

  return {
    prompt: chosenBranch.task,
    chosen: chosenBranch.finalAnswer,
    rejected: rejectedBranch.finalAnswer,
    tool_call_sequence: chosenBranch.toolCallSequence,
    provenance: {
      source: "wasmagent-rollout",
      rollout_id: chosenBranch.rolloutId,
      chosen_branch: chosenRanked.branchIndex,
      rejected_branch: rejectedRanked.branchIndex,
      objective_score: {
        chosen: chosenRanked.objectiveScore,
        rejected: rejectedRanked.objectiveScore,
      },
      exported_at_ms: exportedAtMs,
      n_gram_hash: ngramHash(chosenBranch.task),
    },
  };
}

/**
 * Produce one PPO/GRPO training record per branch.
 */
export function toPpoRecords(
  branches: RolloutBranchResult[],
  ranked: RankedBranch[],
  exportedAtMs: number
): PpoRecord[] {
  const branchMap = buildBranchMap(branches);
  const rankedMap = buildRankedMap(ranked);

  const records: PpoRecord[] = [];
  for (const branch of branches) {
    const r = rankedMap.get(branch.branchIndex);
    if (!r) continue;
    const b = branchMap.get(branch.branchIndex);
    if (!b) continue;

    records.push({
      prompt: b.task,
      completion: b.finalAnswer,
      reward: r.totalScore,
      tool_call_sequence: b.toolCallSequence,
      provenance: {
        source: "wasmagent-rollout",
        rollout_id: b.rolloutId,
        branch_index: b.branchIndex,
        objective_score: r.objectiveScore,
        exported_at_ms: exportedAtMs,
        n_gram_hash: ngramHash(b.task),
      },
    });
  }
  return records;
}

/**
 * Serialize an array of records to JSONL format (one JSON object per line).
 */
export function toJsonl(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}
