export type {
  Model,
  ModelCapabilities,
  ModelMessage,
  ContentBlock,
  TextBlock,
  ImageBlock,
  ToolUseBlock,
  ToolResultBlock,
  GenerateOptions,
  ResponseFormat,
  StreamEvent,
  TokenUsage,
  CacheBreakpoint,
  ResourceBudget,
  EnhancementPolicy,
} from "./types.js";
export { CACHE_MIN_TOKENS, estimateTokens, estimateMessagesTokens, TokenBudget } from "./types.js";

/**
 * AnthropicModel and OpenAIModel are re-exported here for backward compatibility.
 * New projects should import them directly from the dedicated packages:
 *   import { AnthropicModel } from "@agentkit-js/model-anthropic"
 *   import { OpenAIModel }    from "@agentkit-js/model-openai"
 *
 * These re-exports will be removed in a future major version.
 */
export { AnthropicModel } from "./AnthropicModel.js";
export { OpenAIModel } from "./OpenAIModel.js";
export type { OpenAIModelOptions } from "./OpenAIModel.js";
