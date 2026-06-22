// Agents

export type {
  AdaptationDecision,
  // 2026-06-18 (axis 9, L3) — adaptation negotiation types.
  AdaptationProposal,
  AgentSupervisorOptions,
  AgentTeamFactory,
  AgentTeamMember,
  AgentTeamMemberResult,
  AgentTeamOptions,
  AgentTeamResult,
  AgentTeamScorer,
  AgentTeamScorerInput,
  AgentTeamSpawnContext,
  AsToolOptions,
  CodeAgentOptions,
  Criterion,
  CriterionVerdict,
  Goal,
  GoalAgentOptions,
  GoalDirectedAgentOptions,
  GoalDirectedOutcome,
  GoalDirectedRunResult,
  GoalOutcome,
  GoalRunResult,
  HandoffAgent,
  HandoffOptions,
  HandoffResult,
  LLMJudgeVerifierOptions,
  ScoutSnapshot,
  StopCondition,
  StopConditionContext,
  StopPolicyDescriptor,
  SubagentRunnable,
  SupervisorAction,
  SupervisorPolicy,
  ToolCallingAgentOptions,
  VerificationResult,
  Verifier,
  WorkspaceReader,
} from "./agents/index.js";
export {
  AgentSupervisor,
  AgentTeam,
  asTool,
  budgetGuardPolicy,
  CodeAgent,
  callFingerprint,
  composePolicies,
  costBudget,
  DEFAULT_CRITERIA_SYNTH_SYSTEM_PROMPT,
  DeterministicVerifier,
  GoalAgent,
  GoalDirectedAgent,
  handoff,
  handoffGenerator,
  LLM_JUDGE_SYSTEM_PROMPT,
  LLMJudgeVerifier,
  longestAnswerScorer,
  noProgress,
  noProgressPolicy,
  parseCriteriaReply,
  parseStopPolicies,
  parseStopPolicy,
  retryOnErrorPolicy,
  stepCountIs,
  ToolCallingAgent,
  VerificationPipeline,
} from "./agents/index.js";
// F5 — AG-UI inbound channel: frontend tools + JSON-Patch state deltas
export type {
  ApplyStateDeltaOptions,
  BuildFrontendToolsOptions,
  FrontendToolDispatcher,
  FrontendToolSpec,
  StateDeltaOp,
} from "./agui/frontendTools.js";
export { applyStateDelta, buildFrontendTools } from "./agui/frontendTools.js";
export type {
  AgentSnapshot,
  CheckpointableAgentOptions,
  Checkpointer,
  KvBackend,
} from "./checkpoint/index.js";
// Checkpoint / durable workflows
export {
  applyHumanResponse,
  CheckpointableRun,
  InMemoryCheckpointer,
  KvCheckpointer,
  restoreFromSnapshot,
  resumeFromHuman,
} from "./checkpoint/index.js";
export type {
  RedisClientLike,
  RedisClientOptions,
  RedisRestOptions,
} from "./checkpoint/redis.js";
export { RedisKvBackend, RedisRestKvBackend } from "./checkpoint/redis.js";
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
// Enhancement runners
export {
  BudgetForcingRunner,
  ParallelForkJoinRunner,
  ReflectRefineRunner,
  resolveEnhancement,
  RolloutForkRunner,
  RolloutMemoryStore,
  SelfConsistencyRunner,
} from "./enhancement/index.js";
export type {
  AgentRunner,
  AgentTrace,
  Constraints,
  EfficiencyConstraints,
  EvalRunResult,
  EvalSample,
  FaithfulnessOpts,
  JudgeBreakdown,
  JudgeCriterion,
  JudgeScorerOptions,
  JudgeScorerResult,
  LlmJudgeScorerResult,
  RelevanceOpts,
  Scorer,
  ScorerResult,
  WeightedScorer,
} from "./evals/index.js";
// Evals
export {
  ANSWER_COMPLETENESS_CRITERIA,
  answerCompletenessJudge,
  collectTrace,
  compositeScorer,
  constraintScorer,
  efficiencyScorer,
  exactMatch,
  faithfulnessScorer,
  faithfulnessScorerAsync,
  finalAnswerLength,
  guardrailCompliance,
  guardrailComplianceAsync,
  judgeScorer,
  llmJudge,
  llmJudgeAsync,
  recoveryScorer,
  relevanceScorer,
  relevanceScorerAsync,
  runEval,
  runJudgeScorer,
  TRAJECTORY_QUALITY_CRITERIA,
  toolCallAccuracy,
  trajectoryQualityJudge,
  trajectoryValidity,
} from "./evals/index.js";
export type { ErrorClassification } from "./executor/ErrorClassifier.js";
// Error classification — GPT-Engineer improve_loop pattern
export {
  buildFixRetryMessage,
  classifyExecutionError,
  ErrorRecoveryStrategy,
  MAX_REFINEMENT_STEPS,
} from "./executor/ErrorClassifier.js";
export type {
  ActionLanguage,
  CapabilityManifest,
  KernelEngine,
  KernelOptions,
  KernelPoolOptions,
  KernelResult,
  ProgrammaticResult,
  WasmKernel,
} from "./executor/index.js";
// Executor
export {
  assertPathAllowed,
  buildCapabilityGlobals,
  buildSandboxFetch,
  createKernel,
  JsKernel,
  KernelPool,
  matchGlob,
  ProgrammaticOrchestrator,
  VmKernel,
} from "./executor/index.js";
export type {
  ClassifierGuardrailOptions,
  CodeGuardrailOptions,
  GuardrailResult,
  InputGuardrail,
  IntentAlignmentGuardrailOptions,
  OutputGuardrail,
  ToolGuardrail,
  ToolGuardrailContext,
  ToolPostHook,
  ToolPostHookContext,
} from "./guardrails/index.js";
// Guardrails (A1 / S1-S4)
export {
  classifierGuardrail,
  codeGuardrail,
  denyTools,
  forbiddenPhrases,
  intentAlignmentGuardrail,
  llamaGuardAdapter,
  maxInputLength,
  redactPostHook,
  runInputGuardrails,
  runOutputGuardrails,
  runToolGuardrails,
  runToolPostHooks,
  truncatePostHook,
} from "./guardrails/index.js";
export type {
  AssemblerConfig,
  Bm25Match,
  DecayOptions,
  DecayResult,
  EditToolResultsOptions,
  Embedder,
  EmbedResult,
  HybridRetrieverOpts,
  MemoryBlock,
  MemoryEntry,
  MemoryNamespace,
  MemoryToolOptions,
  Observation,
  ObservationalMemoryOptions,
  ObservationPriority,
  QueryFilter,
  Retriever,
  SearchResult,
  SetOptions,
  StructuredKvBackend,
} from "./memory/index.js";
// Memory
export {
  Bm25Indexer,
  bm25Tokenize,
  coreMemoryTools,
  createMemoryTool,
  HybridRetriever,
  hybridRetriever,
  InMemoryStructuredKv,
  InMemoryVectorStore,
  KvBackendVectorStore,
  LazyObservationHandle,
  MapKvBackend,
  MemoryBlockSet,
  MessageAssembler,
  makeRetrievalTool,
  ObservationalMemory,
  StructuredMemory,
  TfidfEmbedder,
} from "./memory/index.js";
export type {
  AnthropicModelId,
  AnthropicModelOptions,
  ContentBlock,
  EnhancementPolicy,
  FallbackModelOptions,
  GenerateOptions,
  GenericOpenAICompatModelOptions,
  ImageBlock,
  Model,
  ModelCapabilities,
  ModelMessage,
  OpenAICompatModelOptions,
  OpenAIModelId,
  OpenAIModelOptions,
  ResourceBudget,
  ResponseFormat,
  RetryPolicy,
  StreamEvent,
  TokenUsage,
} from "./models/index.js";
// Models
export {
  AnthropicModel,
  AnthropicModels,
  CACHE_MIN_TOKENS,
  estimateMessagesTokens,
  estimateTokens,
  FallbackModel,
  GenericOpenAICompatModel,
  OpenAICompatModel,
  OpenAIModel,
  OpenAIModels,
  repairJson,
  TokenBudget,
} from "./models/index.js";
export type {
  GenAiMetricPoint,
  MetricExporter,
  OtelBridgeOptions,
  ReadableSpan,
  SpanAttributes,
  SpanExporter,
} from "./observability/index.js";
// Observability
export { InMemorySpanExporter, OtelBridge, withOtel } from "./observability/index.js";
// Policies — approval gates for write-class tools
export type {
  ApprovalPolicyOptions,
  ApprovalRule,
  WriteOpKind,
} from "./policies/approvalPolicy.js";
export { ApprovalPolicy, applyApprovalPolicy, PolicyPresets } from "./policies/approvalPolicy.js";
export type { ActionIR, CallDescriptor, IRNode, SchedulerEvent } from "./scheduler/index.js";
// Scheduler
export { deriveDependencies, Scheduler, SimpleIR } from "./scheduler/index.js";
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
export type { EventLogOptions, LoggedEvent } from "./streaming/EventLog.js";
// A2 — durable SSE streaming with Last-Event-ID resume
export { EventLog, formatSseFrame } from "./streaming/EventLog.js";
export type { ParsedAction, ParsedActionType } from "./streaming/StreamingActionParser.js";
// Streaming — bolt.diy StreamingMessageParser pattern
export {
  extractActionsFromResponse,
  StreamingActionParser,
} from "./streaming/StreamingActionParser.js";
export type {
  AgentPrincipal,
  McpAuthOptions,
  McpGetPromptResult,
  McpIntegrityOptions,
  McpPromptMessage,
  McpPromptSchema,
  McpResource,
  McpResourceContent,
  McpToolSchema,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "./tools/index.js";
// Tools
export {
  McpAuthError,
  McpToolCollection,
  ToolRegistry,
  toStrictJsonSchema,
  zodToJsonSchema,
} from "./tools/index.js";
// Types
export type {
  ActionStep,
  AgentEvent,
  AgentRunConfig,
  FinalAnswerStep,
  ParallelToolUseCall,
  ParallelToolUseStep,
  PlanningStep,
  Step,
  ToolUseStep,
  UserMessageStep,
} from "./types/index.js";
// Workflow — durable, resumable, resource-aware DAG execution.
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
// F3 — BranchableWorkspace: git-worktree-equivalent isolation for parallel agents
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
// File locking — bolt.new "protect file" pattern
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
// Workspace — Lovable / bolt.diy file state tracking
export {
  FileTreeManager,
  globalFileTree,
} from "./workspace/FileTreeManager.js";
// RLAIF ranking
export type {
  RankedBranch,
  RankingResult,
  RewardFunction,
  RolloutRankerOptions,
  RolloutRecord,
  StatReport,
} from "./ranking/index.js";
export { DEFAULT_REWARD_FUNCTIONS, mcnemarExact, RolloutRanker, wilsonCI } from "./ranking/index.js";
// RLAIF agents (new exports from agents/index.js that aren't in the top-level agents block)
export type {
  BuildPassesVerifierOptions,
  BuildResult,
  BuildResultReader,
  BuildStatus,
  PairwiseVerdict,
  ScalarLLMJudgeVerifierOptions,
  ScalarVerdict,
  SummarizeOptions,
  VisualAssertVerifierOptions,
  VisualResult,
  VisualResultReader,
  VisualVerdict,
} from "./agents/index.js";
export {
  BuildPassesVerifier,
  PAIRWISE_JUDGE_SYSTEM_PROMPT,
  SCORE_JUDGE_SYSTEM_PROMPT,
  ScalarLLMJudgeVerifier,
  summarizeToolOutput,
  VisualAssertVerifier,
} from "./agents/index.js";
