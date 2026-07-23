/**
 * @wasmagent/models — the home of all LLM provider adapters.
 *
 * The volatile provider adapters live here (not in @wasmagent/core) so that a
 * provider tweak does not force a @wasmagent/core release. Core owns only the
 * stable contracts (Model, ModelMessage, GenerateOptions, …); this package owns
 * the implementations that talk to each vendor SDK.
 *
 * Import from subpaths for tree-shaking:
 *   import { DeepSeekModel } from "@wasmagent/models/deepseek";
 * Or from the barrel:
 *   import { AnthropicModel, OpenAIModel, FallbackModel } from "@wasmagent/models";
 *
 * @wasmagent/model-local is NOT included (heavy native node-llama-cpp peer dep).
 */

// Provider adapters (subpath entries).
export * from "./anthropic.js";
export * from "./deepseek.js";
export * from "./doubao.js";
export type { FallbackModelOptions } from "./FallbackModel.js";
// Provider failover (moved out of @wasmagent/core).
export { FallbackModel } from "./FallbackModel.js";
export * from "./minimax.js";
export * from "./moonshot.js";
export type {
  GenericOpenAICompatModelOptions,
  OpenAICompatModelOptions,
} from "./OpenAICompatModel.js";

// OpenAI-compatible base class + generic adapter (moved out of @wasmagent/core).
export { GenericOpenAICompatModel, OpenAICompatModel } from "./OpenAICompatModel.js";
export * from "./openai.js";
export * from "./qwen.js";
// Retry policy type (retry impl is internal to the adapters).
export type { RetryPolicy } from "./retry.js";
export * from "./zhipu.js";
