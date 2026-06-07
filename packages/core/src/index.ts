// Agents
export { CodeAgent, ToolCallingAgent, stepCountIs, noProgress, costBudget, callFingerprint, asTool } from "./agents/index.js";
export type { CodeAgentOptions, ToolCallingAgentOptions, StopCondition, StopConditionContext, AsToolOptions, SubagentRunnable } from "./agents/index.js";

// Executor
export { JsKernel, V8WasmKernel, createKernel, buildCapabilityGlobals, buildSandboxFetch, assertPathAllowed, matchGlob } from "./executor/index.js";
export type {
  WasmKernel,
  KernelResult,
  CapabilityManifest,
  KernelOptions,
  ActionLanguage,
} from "./executor/index.js";

// Memory
export { MessageAssembler, LazyObservationHandle, InMemoryVectorStore, makeRetrievalTool } from "./memory/index.js";
export type { AssemblerConfig, Retriever, EmbedResult, SearchResult } from "./memory/index.js";

// Models
export { AnthropicModel, AnthropicModels, OpenAIModel, OpenAIModels, CACHE_MIN_TOKENS, estimateTokens, estimateMessagesTokens, TokenBudget } from "./models/index.js";
export type {
  Model,
  ModelCapabilities,
  ModelMessage,
  ContentBlock,
  GenerateOptions,
  ResponseFormat,
  StreamEvent,
  TokenUsage,
  ResourceBudget,
  EnhancementPolicy,
  AnthropicModelOptions,
  AnthropicModelId,
  OpenAIModelOptions,
  OpenAIModelId,
  RetryPolicy,
} from "./models/index.js";

// Enhancement runners (P2/P3/S4/L4)
export { SelfConsistencyRunner, ReflectRefineRunner, BudgetForcingRunner, ParallelForkJoinRunner } from "./enhancement/index.js";
export type {
  SelfConsistencyOptions,
  SelfConsistencyResult,
  ReflectRefineOptions,
  ReflectRefineResult,
  BudgetForcingOptions,
  BudgetForcingResult,
  ParallelForkJoinOptions,
  ParallelForkJoinResult,
} from "./enhancement/index.js";

// Tools
export { ToolRegistry, zodToJsonSchema, McpToolCollection } from "./tools/index.js";
export type { ToolDefinition, ToolCall, ToolResult } from "./tools/index.js";

// Scheduler
export { Scheduler, SimpleIR, deriveDependencies } from "./scheduler/index.js";
export type { ActionIR, IRNode, SchedulerEvent, CallDescriptor } from "./scheduler/index.js";

// Evals (B1)
export { exactMatch, toolCallAccuracy, trajectoryValidity, finalAnswerLength, collectTrace, runEval } from "./evals/index.js";
export type { Scorer, ScorerResult, AgentTrace, EvalSample, EvalRunResult, AgentRunner } from "./evals/index.js";

// Observability (C2)
export { OtelBridge, InMemorySpanExporter, withOtel } from "./observability/index.js";
export type { SpanExporter, ReadableSpan, SpanAttributes, OtelBridgeOptions } from "./observability/index.js";

// Checkpoint / durable workflows (B4)
export { InMemoryCheckpointer, KvCheckpointer, CheckpointableRun, restoreFromSnapshot } from "./checkpoint/index.js";
export type { Checkpointer, AgentSnapshot, CheckpointableAgentOptions, KvBackend } from "./checkpoint/index.js";

// Types
export type { AgentEvent, Step, ActionStep, PlanningStep, FinalAnswerStep, ToolUseStep, ParallelToolUseStep, ParallelToolUseCall, UserMessageStep } from "./types/index.js";

