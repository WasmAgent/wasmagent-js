import type { AgentEvent } from "../types/events.js";
import type { RolloutBranchResult } from "../enhancement/RolloutForkRunner.js";
import type { RankedBranch } from "./RolloutRanker.js";

// ── Record types ──────────────────────────────────────────────────────────────

export interface DpoRecord {
  prompt: string;
  chosen: string;
  rejected: string;
  tool_call_sequence: AgentEvent[];
  provenance: {
    source: "wasmagent-rollout";
    rolloutId: string;
    chosenBranch: number;
    rejectedBranch: number;
    objectiveScore: { chosen: 0 | 1; rejected: 0 | 1 };
    exportedAtMs: number;
  };
}

export interface PpoRecord {
  prompt: string;
  completion: string;
  reward: number;
  tool_call_sequence: AgentEvent[];
  provenance: {
    source: "wasmagent-rollout";
    rolloutId: string;
    branchIndex: number;
    objectiveScore: 0 | 1;
    exportedAtMs: number;
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
      rolloutId: chosenBranch.rolloutId,
      chosenBranch: chosenRanked.branchIndex,
      rejectedBranch: rejectedRanked.branchIndex,
      objectiveScore: {
        chosen: chosenRanked.objectiveScore,
        rejected: rejectedRanked.objectiveScore,
      },
      exportedAtMs,
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
        rolloutId: b.rolloutId,
        branchIndex: b.branchIndex,
        objectiveScore: r.objectiveScore,
        exportedAtMs,
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
