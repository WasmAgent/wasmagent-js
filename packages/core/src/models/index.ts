/**
 * @wasmagent/core/models — stable model *contracts* only.
 *
 * The volatile provider adapters (AnthropicModel, OpenAIModel, FallbackModel,
 * OpenAICompatModel, the OpenAI-compat providers, …) have moved to
 * **@wasmagent/models** so that provider churn no longer forces a core release.
 *
 * BREAKING (v3): the adapter classes are no longer re-exported here. Import them
 * from @wasmagent/models (or @wasmagent/models/<provider>) instead:
 *   import { AnthropicModel } from "@wasmagent/models";
 *   import { DeepSeekModel } from "@wasmagent/models/deepseek";
 *
 * This module exports only the contracts every adapter implements, plus the
 * generic JSON-repair helper (used by core agents).
 */

export { repairJson } from "../util/repairJson.js";
export type {
  CacheBreakpoint,
  CacheStrategy,
  ContentBlock,
  EnhancementPolicy,
  GenerateOptions,
  ImageBlock,
  Model,
  ModelCapabilities,
  ModelMessage,
  ModelMeta,
  ReasoningEffort,
  ResourceBudget,
  ResponseFormat,
  StreamEvent,
  TextBlock,
  ThinkingBlock,
  ThinkingOptions,
  TokenUsage,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";
export {
  CACHE_MIN_TOKENS,
  estimateMessagesTokens,
  estimateTokens,
  getModelMeta,
  ModelRegistry,
  TokenBudget,
} from "./types.js";
