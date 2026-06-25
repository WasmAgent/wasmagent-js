/**
 * @wasmagent/compliance — TaskSpec-driven verification + local repair for
 * LLM agent runs.
 *
 * Phase 0 alpha. The public surface is intentionally small:
 *
 *   - `TaskSpec` / `ConstraintIR` — declare what to check.
 *   - `parseTaskSpec` — validate a JSON-shaped spec at runtime.
 *   - `ComplianceVerifier` — turn a TaskSpec + `@wasmagent/core`
 *     `VerificationPipeline` into a violation list with evidence spans.
 *   - `violationFromVerdict` — low-level enrichment helper for custom
 *     verifier authors.
 *
 * RepairPlanner, ComplianceRun, and IFEvalVerifier land in subsequent
 * commits; their slots in the directory tree (`repair/`, `runner/`) are
 * already created so they can be added without restructuring exports.
 */

// IR
export type {
  AdmissionEvaluator,
  AdmissionRule,
  EvidenceAdmissionContract,
  EvidenceRow,
  EvidenceRowType,
  RedactionPolicy,
  ReplayPolicy,
  RuntimeSetting,
} from "./ir/EvidenceAdmission.js";
export {
  EvidenceAdmissionContractSchema,
  EvidenceRowSchema,
  EvidenceRowTypeSchema,
  RedactionPolicySchema,
  ReplayPolicySchema,
  RuntimeSettingSchema,
} from "./ir/EvidenceAdmission.js";
export type {
  ConstraintCategory,
  ConstraintIR,
  ConstraintLevel,
  ConstraintSource,
  RepairPolicy,
  RepairStrategy,
  TaskSpec,
  TaskSpecRepairConfig,
  TaskSpecTraceConfig,
  ToolPolicy,
} from "./ir/ConstraintIR.js";
export {
  ConstraintCategorySchema,
  ConstraintIRSchema,
  ConstraintLevelSchema,
  ConstraintSourceSchema,
  DEFAULT_PRIORITY_HIERARCHY,
  parseTaskSpec,
  RepairPolicySchema,
  RepairStrategySchema,
  TaskSpecRepairConfigSchema,
  TaskSpecSchema,
  TaskSpecTraceConfigSchema,
  ToolPolicySchema,
} from "./ir/ConstraintIR.js";
// Repair layer
export type {
  FakeRepairLLMRule,
  RepairLLM,
  RepairLLMRequest,
  RepairLLMResponse,
} from "./repair/RepairLLM.js";
export { FakeRepairLLM } from "./repair/RepairLLM.js";
export type {
  RepairPlannerOptions,
  RepairResult,
  WorkspaceWriter,
} from "./repair/RepairPlanner.js";
export { RepairPlanner } from "./repair/RepairPlanner.js";
export type { RepairTraceEntry } from "./repair/RepairTrace.js";
export { RepairTraceEntrySchema } from "./repair/RepairTrace.js";
export { InsertSectionStrategy } from "./repair/strategies/insertSection.js";
export { PatchStrategy } from "./repair/strategies/patch.js";
export type { RegenerateRegionStrategyOptions } from "./repair/strategies/regenerateRegion.js";
export { RegenerateRegionStrategy } from "./repair/strategies/regenerateRegion.js";
export type {
  RepairStrategy as RepairStrategyImpl,
  StrategyContext,
  StrategyResult,
} from "./repair/strategies/types.js";
export type {
  ComplianceEvalRecord,
  ComplianceRunOptions,
  RunMode,
} from "./runner/ComplianceRun.js";
export { ComplianceRun } from "./runner/ComplianceRun.js";
// Runner layer (orchestration + adapters)
export type { ModelRepairLLMOptions } from "./runner/ModelRepairLLM.js";
export { ModelRepairLLM } from "./runner/ModelRepairLLM.js";
export type {
  ComplianceVerificationResult,
  ComplianceVerifierOptions,
  EvidenceSpanHook,
} from "./verifier/ComplianceVerifier.js";
export { ComplianceVerifier } from "./verifier/ComplianceVerifier.js";
// IFEval verifier — Phase 0 benchmark target.
export type { IFEvalMethod } from "./verifier/ifeval/IFEvalVerifier.js";
export { IFEvalVerifier } from "./verifier/ifeval/IFEvalVerifier.js";
// Verifier layer
export type {
  ConstraintViolation,
  EvidenceSpan,
  ViolationStage,
} from "./verifier/violation.js";
export {
  ConstraintViolationSchema,
  EvidenceSpanSchema,
  ViolationStageSchema,
  violationFromVerdict,
} from "./verifier/violation.js";
