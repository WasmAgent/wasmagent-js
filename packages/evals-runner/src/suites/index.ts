export { agentTrajectorySuite } from "./agent-trajectory.js";
export { costPerCorrectSuite } from "./cost-per-correct.js";
export { goalDirectedQualitySuite } from "./goal-directed-quality.js";
export { latencyUnderBudgetSuite } from "./latency-under-budget.js";
export { locomoRefinedSuite } from "./locomo-refined.js";
export { longContextRecallSuite } from "./long-context-recall.js";
export { memoryAgentBenchSuite } from "./memory-agent-bench.js";
export {
  multiTurnMemorySuite,
  multiTurnMemorySuiteOriginal,
} from "./multi-turn-memory.js";
export {
  ABLATION_ARMS,
  armBareSuite,
  armCodeSuite,
  armFullSuite,
  armGrammarSuite,
  armParamOnlyOnePassSuite,
  armParamOnlySuite,
  armSelfConsistencySuite,
} from "./multi-turn-scaffold-arms.js";
export { multiTurnToolExecSuite } from "./multi-turn-tool-exec.js";
export { toolSequenceSuite } from "./tool-sequence.js";

import type { BenchmarkSuite } from "../types.js";
import { agentTrajectorySuite } from "./agent-trajectory.js";
import { costPerCorrectSuite } from "./cost-per-correct.js";
import { goalDirectedQualitySuite } from "./goal-directed-quality.js";
import { latencyUnderBudgetSuite } from "./latency-under-budget.js";
import { locomoRefinedSuite } from "./locomo-refined.js";
import { longContextRecallSuite } from "./long-context-recall.js";
import { memoryAgentBenchSuite } from "./memory-agent-bench.js";
import { multiTurnMemorySuite, multiTurnMemorySuiteOriginal } from "./multi-turn-memory.js";
import { multiTurnToolExecSuite } from "./multi-turn-tool-exec.js";
import { toolSequenceSuite } from "./tool-sequence.js";

/** All reference suites, indexed by name. The 6-item original variant of
 *  multi-turn-memory is also registered under
 *  `multi-turn-memory-original-6` for callers (smoke tests, contract
 *  pins) that need a fixed denominator across enrichments of the main
 *  LoCoMo-style 63-item suite. */
export const REFERENCE_SUITES: Record<string, BenchmarkSuite> = {
  [multiTurnMemorySuite.name]: multiTurnMemorySuite,
  [multiTurnMemorySuiteOriginal.name]: multiTurnMemorySuiteOriginal,
  [longContextRecallSuite.name]: longContextRecallSuite,
  [costPerCorrectSuite.name]: costPerCorrectSuite,
  [toolSequenceSuite.name]: toolSequenceSuite,
  [agentTrajectorySuite.name]: agentTrajectorySuite,
  [latencyUnderBudgetSuite.name]: latencyUnderBudgetSuite,
  [multiTurnToolExecSuite.name]: multiTurnToolExecSuite,
  [locomoRefinedSuite.name]: locomoRefinedSuite,
  [memoryAgentBenchSuite.name]: memoryAgentBenchSuite,
  [goalDirectedQualitySuite.name]: goalDirectedQualitySuite,
};
