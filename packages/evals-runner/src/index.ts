/**
 * @agentkit-js/evals-runner — multi-model multi-axis evaluation harness.
 *
 * Composes agentkit's existing scorers, EventLog, and statistical
 * primitives into a complete pipeline: dataset in, Pareto report out.
 * Covers the axes accuracy-only benchmarks miss: long-context recall,
 * multi-turn memory, agent trajectory, latency, cost.
 *
 * agentkit-js is independent — this package adds an evaluation layer on
 * top of agentkit's primitives, but the runtime keeps no knowledge of
 * any specific consumer.
 *
 * Public API:
 *   - runEvaluation(opts) — the entry point.
 *   - REFERENCE_SUITES   — six pre-built suites.
 *   - renderReportMarkdown — markdown renderer for the report.
 *   - { mcnemarExact, wilsonCI, pairedBootstrap, buildG1Report } —
 *     stats primitives, also reachable via "@agentkit-js/evals-runner/stats".
 *   - { estimateJoulesPerCorrect, renderEnergyTable } — P16-8 ④ energy axis.
 */

export { renderReportCompact, renderReportMarkdown } from "./report.js";
export { defaultProvider, runEvaluation } from "./runner.js";
export type { G1Report, SeedResult } from "./stats/index.js";
// Stats primitives — also under "@agentkit-js/evals-runner/stats".
export {
  binomialCDF,
  buildG1Report,
  invNormalCDF,
  mcnemarExact,
  pairedBootstrap,
  wilsonCI,
} from "./stats/index.js";
export {
  agentTrajectorySuite,
  costPerCorrectSuite,
  latencyUnderBudgetSuite,
  longContextRecallSuite,
  multiTurnMemorySuite,
  multiTurnToolExecSuite,
  REFERENCE_SUITES,
  toolSequenceSuite,
} from "./suites/index.js";
// Energy estimation (P16-8 ④)
export {
  estimateJoulesPerCorrect,
  renderEnergyRow,
  renderEnergyTable,
} from "./energy.js";
export type {
  EnergyReport,
  EnergySpec,
} from "./energy.js";
export type {
  BenchmarkItem,
  BenchmarkSuite,
  EvaluationReport,
  ModelProvider,
  ModelSpec,
  RunEvaluationOptions,
  RunItemResult,
  RunResult,
  SuiteAggregate,
} from "./types.js";

