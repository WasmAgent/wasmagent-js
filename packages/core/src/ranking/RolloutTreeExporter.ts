import type { RolloutBranchResult } from "../enhancement/RolloutForkRunner.js";
import type { DpoRecord } from "./RolloutExporter.js";
import { toDpoRecord } from "./RolloutExporter.js";
import type { RankedBranch } from "./RolloutRanker.js";

export interface RolloutTreeBranch {
  branch_index: number;
  temperature: number;
  final_answer: string;
  objective_score: 0 | 1;
  total_score: number;
  forked_at_step: number;
  forked_at_event_id: string;
  shared_prefix_steps: number;
}

export interface RolloutTreeRecord {
  rollout_id: string;
  task: string;
  branches: RolloutTreeBranch[];
  fork_map: Record<number, number[]>;
}

export interface ForkContext {
  forkedAtStep: number;
  forkedAtEventId: string;
}

/**
 * Build a RolloutTreeRecord from branches with fork context.
 */
export function buildTreeRecord(
  branches: RolloutBranchResult[],
  ranked: RankedBranch[],
  forkContexts: Map<number, ForkContext>
): RolloutTreeRecord | null {
  if (branches.length === 0) return null;

  // biome-ignore lint/style/noNonNullAssertion: length > 0 checked above
  const first = branches[0]!;
  const rankedMap = new Map(ranked.map((r) => [r.branchIndex, r]));

  const treeBranches: RolloutTreeBranch[] = branches.map((b) => {
    const r = rankedMap.get(b.branchIndex);
    const fc = forkContexts.get(b.branchIndex);
    return {
      branch_index: b.branchIndex,
      temperature: b.temperature,
      final_answer: b.finalAnswer,
      objective_score: r?.objectiveScore ?? 0,
      total_score: r?.totalScore ?? 0,
      forked_at_step: fc?.forkedAtStep ?? 0,
      forked_at_event_id: fc?.forkedAtEventId ?? "",
      shared_prefix_steps: fc?.forkedAtStep ?? 0,
    };
  });

  // Build fork_map: step_index -> branch_indices that diverged here
  const forkMap: Record<number, number[]> = {};
  for (const b of treeBranches) {
    const step = b.forked_at_step;
    if (!forkMap[step]) forkMap[step] = [];
    // biome-ignore lint/style/noNonNullAssertion: initialized above
    forkMap[step]!.push(b.branch_index);
  }

  return {
    rollout_id: first.rolloutId,
    task: first.task,
    branches: treeBranches,
    fork_map: forkMap,
  };
}

/**
 * Generate DPO pairs restricted to branches that diverged at the same fork point.
 * This enables step-level credit assignment: "same state, different action at step K."
 */
export function toDpoRecordWithForkContext(
  branches: RolloutBranchResult[],
  ranked: RankedBranch[],
  forkContexts: Map<number, ForkContext>,
  exportedAtMs: number
): DpoRecord[] {
  // Group branches by fork point
  const byForkStep = new Map<number, number[]>();
  for (const [branchIndex, fc] of forkContexts) {
    const step = fc.forkedAtStep;
    if (!byForkStep.has(step)) byForkStep.set(step, []);
    // biome-ignore lint/style/noNonNullAssertion: initialized above
    byForkStep.get(step)!.push(branchIndex);
  }

  const records: DpoRecord[] = [];

  for (const [_step, branchIndices] of byForkStep) {
    if (branchIndices.length < 2) continue;

    // Filter to branches at this fork point
    const forkBranches = branches.filter((b) => branchIndices.includes(b.branchIndex));
    const forkRanked = ranked.filter((r) => branchIndices.includes(r.branchIndex));

    const record = toDpoRecord(forkBranches, forkRanked, exportedAtMs);
    if (record) records.push(record);
  }

  return records;
}
