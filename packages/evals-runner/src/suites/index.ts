export { agentTrajectorySuite } from "./agent-trajectory.js";
export { costPerCorrectSuite } from "./cost-per-correct.js";
export { latencyUnderBudgetSuite } from "./latency-under-budget.js";
export { longContextRecallSuite } from "./long-context-recall.js";
export { multiTurnMemorySuite } from "./multi-turn-memory.js";
export { toolSequenceSuite } from "./tool-sequence.js";

import type { BenchmarkSuite } from "../types.js";
import { agentTrajectorySuite } from "./agent-trajectory.js";
import { costPerCorrectSuite } from "./cost-per-correct.js";
import { latencyUnderBudgetSuite } from "./latency-under-budget.js";
import { longContextRecallSuite } from "./long-context-recall.js";
import { multiTurnMemorySuite } from "./multi-turn-memory.js";
import { toolSequenceSuite } from "./tool-sequence.js";

/** All 6 reference suites, indexed by name. */
export const REFERENCE_SUITES: Record<string, BenchmarkSuite> = {
  [multiTurnMemorySuite.name]: multiTurnMemorySuite,
  [longContextRecallSuite.name]: longContextRecallSuite,
  [costPerCorrectSuite.name]: costPerCorrectSuite,
  [toolSequenceSuite.name]: toolSequenceSuite,
  [agentTrajectorySuite.name]: agentTrajectorySuite,
  [latencyUnderBudgetSuite.name]: latencyUnderBudgetSuite,
};
