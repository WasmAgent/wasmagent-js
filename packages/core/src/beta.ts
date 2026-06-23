// @wasmagent/core/beta — unstable APIs that may change in minor versions.
// Import from here to signal you accept beta-level stability.
// Changes are announced in CHANGELOG.md under the [beta] tag.

// Enhancement runners
export type {
  BudgetForcingOptions,
  BudgetForcingResult,
  EnhancementPreset,
  ParallelForkJoinOptions,
  ParallelForkJoinResult,
  ReflectRefineOptions,
  ReflectRefineResult,
  RolloutBranchResult,
  RolloutForkRunnerOptions,
  RolloutMemory,
  RolloutMemoryRecord,
  RolloutMemoryStoreOptions,
  SelfConsistencyOptions,
  SelfConsistencyResult,
} from "./enhancement/index.js";
export {
  BudgetForcingRunner,
  ParallelForkJoinRunner,
  ReflectRefineRunner,
  RolloutForkRunner,
  RolloutMemoryStore,
  resolveEnhancement,
  SelfConsistencyRunner,
} from "./enhancement/index.js";
// Evals
export type {
  EvalRunResult,
  EvalSample,
  Scorer,
  ScorerResult,
} from "./evals/index.js";
export {
  exactMatch,
  finalAnswerLength,
  runEval,
  toolCallAccuracy,
  trajectoryValidity,
} from "./evals/index.js";
// Guardrail scorers (used in evals context)
export { forbiddenPhrases, maxInputLength } from "./guardrails/index.js";
// EnhancementPolicy lives in models/types but is part of the beta surface
export type { EnhancementPolicy } from "./models/types.js";

// RLAIF ranking
export type {
  DpoRecord,
  PpoRecord,
  RankedBranch,
  RankingResult,
  RewardFunction,
  RolloutRankerOptions,
  RolloutRecord,
  StatReport,
} from "./ranking/index.js";
export {
  DEFAULT_REWARD_FUNCTIONS,
  mcnemarExact,
  RolloutRanker,
  toDpoRecord,
  toJsonl,
  toPpoRecords,
  wilsonCI,
} from "./ranking/index.js";

// Scheduler
export type { ActionIR, CallDescriptor, IRNode, SchedulerEvent } from "./scheduler/index.js";
export { deriveDependencies, Scheduler, SimpleIR } from "./scheduler/index.js";

// Skills
export type {
  ActivationResult,
  AgentsMdLoader,
  ProjectInstructionsOptions,
  ResolvedInstructions,
  Skill,
  SkillBody,
  SkillManifest,
  SkillTrigger,
} from "./skills/index.js";
export {
  AGENTS_MD_FILENAME,
  makeKvAgentsMdLoader,
  makeNodeAgentsMdLoader,
  ProjectInstructions,
  SkillRegistry,
} from "./skills/index.js";

// Workflow
export type {
  AcquireOptions,
  LocalWorkflowEngineOptions,
  PoolConfig,
  ResourceClaim,
  ResourceLease,
  ResourcePool,
  StartOptions,
  StepRetryPolicy,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowEventEnvelope,
  WorkflowRunHandle,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStateStore,
  WorkflowStep,
  WorkflowStepRecord,
  WorkflowStepStatus,
} from "./workflow/index.js";
export {
  InMemoryResourcePool,
  KvWorkflowStateStore,
  LocalWorkflowEngine,
  MemoryKvBackend,
} from "./workflow/index.js";

// BranchableWorkspace + file utilities
export type {
  BranchMeta,
  FileChange,
  MergeConflict,
  MergeResult,
  MergeStrategy,
} from "./workspace/BranchableWorkspace.js";
export {
  BranchableWorkspace,
  openOrCreateRoot,
} from "./workspace/BranchableWorkspace.js";
export type { LockedFile, LockLevel } from "./workspace/FileLockManager.js";
export {
  FileLockManager,
  globalFileLock,
} from "./workspace/FileLockManager.js";
export type {
  FileEntry,
  FileTreeSummary,
  FileVersion,
  ScoredFile,
} from "./workspace/FileTreeManager.js";
