// ─────────────────────────────────────────────────────────────────────────────
// @wasmagent/core public API
//
// Stability tiers (per section):
//   [stable]      — semver-compatible; no breaking changes without a major bump
//   [beta]        — API shape may change in minor versions; changes announced
//   [experimental] — may change or be removed at any time; no stability promise
// ─────────────────────────────────────────────────────────────────────────────

// Agents [stable]

// RLAIF agents (new exports from agents/index.js that aren't in the top-level agents block)
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
  BuildPassesVerifierOptions,
  BuildResult,
  BuildResultReader,
  BuildStatus,
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
  PairwiseVerdict,
  ScalarLLMJudgeVerifierOptions,
  ScalarVerdict,
  ScoutSnapshot,
  StopCondition,
  StopConditionContext,
  StopPolicyDescriptor,
  SubagentRunnable,
  SummarizeOptions,
  SupervisorAction,
  SupervisorPolicy,
  ToolCallingAgentOptions,
  VerificationResult,
  Verifier,
  VisualAssertVerifierOptions,
  VisualResult,
  VisualResultReader,
  VisualVerdict,
  WorkspaceReader,
} from "./agents/index.js";
export {
  AgentSupervisor,
  AgentTeam,
  asTool,
  BuildPassesVerifier,
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
  PAIRWISE_JUDGE_SYSTEM_PROMPT,
  parseCriteriaReply,
  parseStopPolicies,
  parseStopPolicy,
  retryOnErrorPolicy,
  SCORE_JUDGE_SYSTEM_PROMPT,
  ScalarLLMJudgeVerifier,
  stepCountIs,
  summarizeToolOutput,
  ToolCallingAgent,
  VerificationPipeline,
  VisualAssertVerifier,
} from "./agents/index.js";
// F5 — AG-UI inbound channel: frontend tools + JSON-Patch state deltas [stable]
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
// Checkpoint / durable workflows [stable]
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
// Executor [stable]
export type {
  ActionLanguage,
  CapabilityManifest,
  KernelEngine,
  KernelOptions,
  KernelPoolOptions,
  KernelPoolValidatorOptions,
  KernelResult,
  KernelValidationResult,
  ProgrammaticResult,
  ValidationTask,
  WasmKernel,
} from "./executor/index.js";
export {
  assertPathAllowed,
  buildCapabilityGlobals,
  buildSandboxFetch,
  createKernel,
  JsKernel,
  KernelPool,
  KernelPoolValidator,
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
// Guardrails (A1 / S1-S4) [stable]
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
// Memory [stable]
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
// Models [stable]
// Canonical import: @wasmagent/model-anthropic / @wasmagent/model-openai / etc.
// The exports below are batteries-included shortcuts — same implementations,
// re-exported here so single-package installs work without provider packages.
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
// Policies — approval gates for write-class tools [stable]
export type {
  ApprovalDecision,
  ApprovalPolicyOptions,
  ApprovalRequest,
  ApprovalRule,
  ApprovalStore,
  WriteOpKind,
} from "./policies/index.js";
export {
  ApprovalPolicy,
  applyApprovalPolicy,
  CloudflareKvApprovalStore,
  InMemoryApprovalStore,
  PolicyPresets,
} from "./policies/index.js";
// A2 — durable SSE streaming with Last-Event-ID resume [stable]
export type { EventLogOptions, LoggedEvent } from "./streaming/EventLog.js";
export { EventLog, formatSseFrame } from "./streaming/EventLog.js";
export type { ParsedAction, ParsedActionType } from "./streaming/StreamingActionParser.js";
// Streaming — bolt.diy StreamingMessageParser pattern [stable]
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
// Tools [stable]
export {
  McpAuthError,
  McpToolCollection,
  ToolRegistry,
  toStrictJsonSchema,
  zodToJsonSchema,
} from "./tools/index.js";
// Types [stable]
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

// Beta and experimental APIs are available via sub-path imports:
//   import { ... } from "@wasmagent/core/beta"
//   import { ... } from "@wasmagent/core/experimental"
