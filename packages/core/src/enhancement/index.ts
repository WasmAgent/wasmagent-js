export type { BudgetForcingOptions, BudgetForcingResult } from "./BudgetForcingRunner.js";
export { BudgetForcingRunner } from "./BudgetForcingRunner.js";
export type { ParallelForkJoinOptions, ParallelForkJoinResult } from "./ParallelForkJoinRunner.js";
export { ParallelForkJoinRunner } from "./ParallelForkJoinRunner.js";
export type { ReflectRefineOptions, ReflectRefineResult } from "./ReflectRefineRunner.js";
export { ReflectRefineRunner } from "./ReflectRefineRunner.js";
export type {
  RolloutBranchResult,
  RolloutForkRunnerOptions,
} from "./RolloutForkRunner.js";
export { RolloutForkRunner } from "./RolloutForkRunner.js";
export type {
  RolloutMemory,
  RolloutMemoryRecord,
  RolloutMemoryStoreOptions,
} from "./RolloutMemoryStore.js";
export { RolloutMemoryStore } from "./RolloutMemoryStore.js";
export type { SelfConsistencyOptions, SelfConsistencyResult } from "./SelfConsistencyRunner.js";
export { SelfConsistencyRunner } from "./SelfConsistencyRunner.js";

// ── Super-instruction: EnhancementPreset string shortcuts ────────────────────

import type { EnhancementPolicy } from "../models/types.js";

/**
 * A named preset that maps to a ready-to-use `EnhancementPolicy`.
 * Pass to `resolveEnhancement()` and hand the result directly to
 * `ToolCallingAgent({ enhancementPolicy: ... })`.
 */
export type EnhancementPreset =
  | "none"
  | "reflect-once"
  | "self-consistency:3"
  | "parallel-fork:3"
  | "budget-forcing";

/** Resolve an `EnhancementPreset` string to a configured `EnhancementPolicy`. */
export function resolveEnhancement(preset: EnhancementPreset): EnhancementPolicy | undefined {
  if (preset === "none") return undefined;
  if (preset === "reflect-once") return { reflectRefine: { enabled: true, maxCycles: 1 } };
  if (preset === "self-consistency:3") return { selfConsistency: { enabled: true, n: 3 } };
  if (preset === "parallel-fork:3") return { parallelForkJoin: { enabled: true, branches: 3 } };
  if (preset === "budget-forcing") return { budgetForcing: { enabled: true } };
  return undefined;
}
