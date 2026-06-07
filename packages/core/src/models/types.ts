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
  /** True when the tool execution produced an error. Maps to Anthropic is_error. */
  isError?: boolean;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock;

/**
 * Cache breakpoint — marks end of an immutable prefix segment (B1).
 * Anthropic: cache_control: { type: 'ephemeral', ttl?: '5m' | '1h' }
 *   - '5m' (default): standard 5-minute TTL
 *   - '1h': extended 1-hour TTL (requires extended-cache-ttl-2025-04-11 beta header)
 * OpenAI: implicit prefix caching (no explicit marker needed)
 */
export interface CacheBreakpoint {
  type: "ephemeral";
  /**
   * Cache TTL for Anthropic breakpoints.
   * - '5m' (default): standard ephemeral cache, expires in 5 minutes
   * - '1h': extended cache, expires in 1 hour; use for long agent workflows
   *         where the same context is reused across many steps
   */
  ttl?: "5m" | "1h";
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
  /** Nucleus sampling probability mass (0-1). Passed as top_p to OpenAI, top_p to Anthropic. */
  topP?: number;
  /** Random seed for deterministic sampling (OpenAI only). */
  seed?: number;
  /** Explicit cache breakpoints for prompt prefix caching (B1). */
  cacheBreakpoints?: CacheBreakpoint[];
  stopSequences?: string[];
  /**
   * Structured output constraint (S1).
   * When set, the model is instructed to produce JSON matching the given JSON Schema.
   * Only used when ModelCapabilities.supportsGrammar is true.
   * Callers should fall back to S2 (extractCode retry) when the capability is absent.
   */
  responseFormat?: ResponseFormat;
}

/** Structured output format constraint for JSON grammar (S1). */
export type ResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; schema: object; name?: string; strict?: boolean };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens read from the standard 5-minute cache (Anthropic cache_read_input_tokens / ephemeral_5m). */
  cacheReadTokens?: number;
  /** Tokens written to cache (Anthropic cache_creation_input_tokens). */
  cacheWriteTokens?: number;
  /** Tokens read from the 1-hour extended cache (Anthropic ephemeral_1h_input_tokens). */
  cacheReadTokens1h?: number;
  /** Tokens written to the 1-hour extended cache (Anthropic cache_creation ephemeral_1h). */
  cacheWriteTokens1h?: number;
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
  /** Optional capability descriptor — agents use this to gate features (O3). */
  capabilities?: ModelCapabilities;
  generate(
    messages: ModelMessage[],
    opts?: GenerateOptions
  ): AsyncGenerator<StreamEvent>;
}

/** Describes what an underlying model endpoint can and cannot do (O3). */
export interface ModelCapabilities {
  /** True when the endpoint is a local/private server (Ollama, vLLM, llama.cpp). */
  localEndpoint?: boolean;
  /** True when the provider charges per-token (affects budget-aware strategies). */
  metered?: boolean;
  /** True when the model supports grammar/response_format structured output (S1). */
  supportsGrammar?: boolean;
  /** True when the model supports "Wait" budget-forcing prefill injection (S4). */
  supportsBudgetForcing?: boolean;
  /** Context window size in tokens (for compaction threshold). */
  contextWindow?: number;
}

/**
 * Token and step budget limits for a single agent run (P1).
 * Agents check these limits before each step and abort gracefully when exceeded.
 */
export interface ResourceBudget {
  /** Maximum total tokens (input + output) across all steps. */
  maxTokens?: number;
  /** Maximum number of steps before forcing a final answer. */
  maxSteps?: number;
  /** Maximum wall-clock milliseconds for the entire run. */
  maxDurationMs?: number;
}

/**
 * Enhancement policy — controls which optional quality strategies are enabled (P1).
 * Agents read this config to decide whether to run self-consistency, budget
 * forcing, Reflect-Refine, etc.
 */
export interface EnhancementPolicy {
  /** Resource budget for the run. */
  budget?: ResourceBudget;
  /** Enable self-consistency voting (P2). N candidate generations, majority vote. */
  selfConsistency?: {
    enabled: boolean;
    /** Number of candidate completions to generate (default 3). */
    n?: number;
    /** Abort early when this fraction of votes agree (default 0.6). */
    earlyStopThreshold?: number;
  };
  /** Enable Reflect-Refine loop (P3). Critique then regenerate when quality is low. */
  reflectRefine?: {
    enabled: boolean;
    /** Max reflection-refinement cycles per answer (default 1). */
    maxCycles?: number;
  };
  /** Enable budget-forcing "Wait" prefill injection (S4). Requires model support. */
  budgetForcing?: {
    enabled: boolean;
  };
  /** Enable parallel fork-join diversity reasoning (L4). Forks N branches, synthesises. */
  parallelForkJoin?: {
    enabled: boolean;
    /** Number of parallel branches (default 3). */
    branches?: number;
    /** Max concurrent branch calls (default: branches). */
    concurrency?: number;
    /** Aggregation strategy: "summary" (default) or "first". */
    aggregation?: "summary" | "first";
  };
}

/** Minimum token threshold per model for cache breakpoints to be effective (B1). */
export const CACHE_MIN_TOKENS: Record<string, number> = {
  "claude-opus-4": 1024,
  "claude-opus-4-5": 4096,
  "claude-opus-4-6": 4096,
  "claude-sonnet-4": 1024,
  "claude-sonnet-4-5": 1024,
  "claude-sonnet-4-6": 1024,
  "claude-haiku-3": 2048,
  "claude-haiku-4-5": 4096,
};

/**
 * Estimate token count from a string for cache threshold comparisons (B1).
 *
 * Uses character-category weighting to handle CJK / non-ASCII content:
 *   ASCII: ~4 chars/token (English prose, code)
 *   Non-ASCII: 1 token/char (conservative lower bound)
 *
 * Non-ASCII covers: CJK (~1 token/char), Arabic/Thai/Devanagari (often
 * >1 token/char), and emoji (multi-codepoint, often 2-4 tokens each).
 * Using /1 as the non-ASCII floor means we reliably over-estimate for
 * these scripts rather than under-estimate.
 *
 * This is intentionally conservative (biases to over-estimate) because
 * missing a cache breakpoint costs real money; an extra cache_control
 * annotation costs almost nothing.
 */
export function estimateTokens(text: string): number {
  let ascii = 0, wide = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) < 128) ascii++;
    else wide++;
  }
  // wide: 1 token/char lower bound (not /1.5 — see function comment)
  return Math.ceil(ascii / 4 + wide);
}

/** Estimates total tokens across a message array (sum of all content text). */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      total += estimateTokens(m.content);
    } else {
      for (const block of m.content) {
        if (block.type === "text") total += estimateTokens(block.text);
        else if (block.type === "tool_result") total += estimateTokens(block.content);
        else if (block.type === "tool_use") total += estimateTokens(JSON.stringify(block.input));
      }
    }
  }
  return total;
}

/**
 * Token budget tracker — accumulates real usage from model events and falls
 * back to estimateTokens() when the model does not report usage (P0).
 */
export class TokenBudget {
  inputTokens = 0;
  outputTokens = 0;

  /** Record real usage from a usage StreamEvent. */
  recordUsage(usage: TokenUsage): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
  }

  /** Fall back to estimation when no usage event was received for a step. */
  estimateFallback(messages: ModelMessage[], responseText: string): void {
    this.inputTokens += estimateMessagesTokens(messages);
    this.outputTokens += estimateTokens(responseText);
  }

  get total(): number { return this.inputTokens + this.outputTokens; }
}
