/**
 * Model abstraction layer (E1).
 *
 * Mirrors smolagents' model-agnostic design (models.py) while adding:
 *  - Fully async streaming (0 async def in smolagents)
 *  - cache_control breakpoints for Anthropic prompt caching (B1)
 *  - Unified token usage reporting
 */

export type ContentRole = "system" | "user" | "assistant" | "tool";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  /** URL or base64 data URI. */
  source: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock;

/**
 * Cache breakpoint — marks end of an immutable prefix segment (B1).
 * Anthropic: cache_control: { type: 'ephemeral' }
 * OpenAI: implicit prefix caching (no explicit marker needed)
 */
export interface CacheBreakpoint {
  /** Block index in the messages array after which to insert the breakpoint. */
  afterBlockIndex: number;
  type: "ephemeral";
}

export interface ModelMessage {
  role: ContentRole;
  content: string | ContentBlock[];
  /** Optional cache breakpoint to insert after this message (B1). */
  cacheBreakpoint?: CacheBreakpoint;
}

export interface GenerateOptions {
  tools?: object[];
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Explicit cache breakpoints for prompt prefix caching (B1). */
  cacheBreakpoints?: CacheBreakpoint[];
  stopSequences?: string[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens read from cache (Anthropic cache_read_input_tokens). */
  cacheReadTokens?: number;
  /** Tokens written to cache (Anthropic cache_creation_input_tokens). */
  cacheWriteTokens?: number;
}

export interface StreamEvent {
  type: "text_delta" | "tool_call" | "stop" | "usage";
  delta?: string;
  toolCall?: ToolUseBlock;
  stopReason?: "end_turn" | "tool_use" | "max_tokens";
  usage?: TokenUsage;
}

/**
 * Unified async model interface (E1).
 * Replaces smolagents' synchronous models.py provider classes.
 */
export interface Model {
  /** Provider identifier for logging and cache-threshold validation (B1). */
  providerId: string;
  generate(
    messages: ModelMessage[],
    opts?: GenerateOptions
  ): AsyncGenerator<StreamEvent>;
}

/** Minimum token threshold per model for cache breakpoints to be effective (B1). */
export const CACHE_MIN_TOKENS: Record<string, number> = {
  "claude-opus-4": 1024,
  "claude-opus-4-5": 4096,
  "claude-opus-4-6": 4096,
  "claude-sonnet-4": 1024,
  "claude-haiku-3": 2048,
  "claude-haiku-4-5": 4096,
};
