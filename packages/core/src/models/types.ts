/**
 * Model abstraction layer.
 *
 * Unified interface across Anthropic, OpenAI, and OpenAI-compatible endpoints:
 *  - Adaptive thinking + unified effort/verbosity (A1/A2)
 *  - Prompt-cache breakpoints (B1/B2)
 *  - Structured output (A3)
 *  - ModelRegistry for per-model capability metadata (A4)
 *  - cacheStrategy for OpenAI-compatible endpoints (B3)
 */

export type ContentRole = "system" | "user" | "assistant" | "tool";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
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
  isError?: boolean;
}

/** Thinking/reasoning block returned by models that support extended thinking. */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  /** Opaque signature required to re-send thinking blocks in multi-turn (Anthropic). */
  signature?: string;
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

/**
 * Cache breakpoint — marks end of an immutable prefix segment (B1).
 * Anthropic: cache_control: { type: 'ephemeral', ttl?: '5m' | '1h' }
 * OpenAI/compat: implicit prefix caching (marker ignored)
 */
export interface CacheBreakpoint {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export interface ModelMessage {
  role: ContentRole;
  content: string | ContentBlock[];
  cacheBreakpoint?: CacheBreakpoint;
}

// ── Thinking / Reasoning options (A1 / A2) ───────────────────────────────────

/**
 * Reasoning effort level — shared abstraction across providers.
 *
 * Anthropic: maps to thinking.effort (standard/high/xhigh/max).
 * OpenAI:    maps to reasoning.effort (none/minimal/low/medium/high/xhigh).
 */
export type ReasoningEffort =
  | "none" // OpenAI only: disable reasoning
  | "minimal" // OpenAI only
  | "standard" // Anthropic: default adaptive thinking depth
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"; // Anthropic only

export interface ThinkingOptions {
  /**
   * - "adaptive" (Anthropic ≥4.7): automatic depth, driven by effort.
   * - "enabled":  explicit budget_tokens (Anthropic ≤4.5 only).
   * - "off":      disable thinking.
   */
  mode: "adaptive" | "enabled" | "off";
  /** Effort level for adaptive mode. Ignored when mode is "enabled" or "off". */
  effort?: ReasoningEffort;
  /**
   * Manual token budget — only for mode:"enabled" on Anthropic ≤4.5.
   * Using this on Anthropic ≥4.7 throws a clear error (adapter-level guard).
   */
  budgetTokens?: number;
}

// ── GenerateOptions ───────────────────────────────────────────────────────────

export interface GenerateOptions {
  tools?: object[];
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  cacheBreakpoints?: CacheBreakpoint[];
  stopSequences?: string[];
  responseFormat?: ResponseFormat;
  /**
   * Thinking/reasoning configuration (A1/A2).
   * Anthropic: thinking.mode + effort.
   * OpenAI reasoning models: effort only (mode is ignored).
   */
  thinking?: ThinkingOptions;
  /**
   * Output verbosity hint (A2, OpenAI GPT-5+).
   * "low" = terse; "medium" = default; "high" = detailed.
   */
  verbosity?: "low" | "medium" | "high";
  /**
   * When true, instructs the model to call tools one at a time (sequential).
   * Prevents the parallel-batch empty-args bug where one call in a batch
   * has path=undefined/content=undefined due to streaming truncation.
   * Anthropic: maps to tool_choice.disable_parallel_tool_use=true.
   */
  disableParallelToolUse?: boolean;
}

export type ResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; schema: object; name?: string; strict?: boolean };

// ── Token usage ───────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Thinking/reasoning tokens billed separately (Anthropic/OpenAI reasoning). */
  thinkingTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens1h?: number;
  cacheWriteTokens1h?: number;
}

// ── StreamEvent ───────────────────────────────────────────────────────────────

export interface StreamEvent {
  type: "text_delta" | "thinking_delta" | "tool_call" | "stop" | "usage";
  delta?: string;
  toolCall?: ToolUseBlock;
  stopReason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage?: TokenUsage;
}

// ── Model interface ───────────────────────────────────────────────────────────

export interface Model {
  providerId: string;
  capabilities?: ModelCapabilities;
  generate(messages: ModelMessage[], opts?: GenerateOptions): AsyncGenerator<StreamEvent>;
}

// ── ModelCapabilities ─────────────────────────────────────────────────────────

/**
 * Cache injection strategy for the provider (B3).
 *
 * - "anthropic-explicit": provider uses cache_control blocks (Anthropic).
 * - "auto-prefix":        provider caches automatically by prefix; no explicit markers needed (default for compat).
 * - "ark-context":        Volcengine Ark explicit Context API — requires context_id, incurs per-hour storage cost.
 * - "none":               no caching supported.
 */
export type CacheStrategy = "anthropic-explicit" | "auto-prefix" | "ark-context" | "none";

export interface ModelCapabilities {
  localEndpoint?: boolean;
  metered?: boolean;
  /** True when the model supports JSON-schema structured output. */
  supportsGrammar?: boolean;
  supportsBudgetForcing?: boolean;
  contextWindow?: number;
  /** True when the model supports native reasoning effort control (A2). */
  supportsReasoningEffort?: boolean;
  /** True when the model supports verbosity output length control (A2). */
  supportsVerbosity?: boolean;
  /**
   * Cache injection strategy (B3).
   * Defaults to "auto-prefix" for OpenAI-compatible endpoints.
   */
  cacheStrategy?: CacheStrategy;
  /**
   * Field name in the raw API response that carries reasoning/thinking text.
   * Used by OpenAI-compatible adapters that return reasoning in a non-standard field.
   * E.g. DeepSeek: "reasoning_content", Kimi: "thinking_content".
   */
  reasoningContentField?: string;
}

// ── ModelRegistry (A4) ───────────────────────────────────────────────────────

export interface ModelMeta {
  /** Maximum context window in tokens. */
  contextWindow: number;
  /** Whether the model has built-in reasoning/thinking capability. */
  isReasoning: boolean;
  /** Whether the model accepts explicit effort levels. */
  supportsReasoningEffort: boolean;
  /** Whether the model accepts verbosity control (OpenAI GPT-5+). */
  supportsVerbosity: boolean;
  /** Default effort when reasoning is enabled but no effort is specified. */
  defaultEffort?: ReasoningEffort;
  /**
   * Pricing in USD per million tokens. All fields optional — when missing,
   * `priceFor()` falls back to a sensible default and `estimatedUsd()` flags
   * the value as a default approximation. Source: official provider pricing
   * pages as of 2026-06-11; update when pricing changes.
   */
  inputUsdPerMTok?: number;
  outputUsdPerMTok?: number;
  cacheReadUsdPerMTok?: number;
  cacheWriteUsdPerMTok?: number;
  /**
   * Anthropic prompt-cache 1-hour TTL write rate. Approximately 2× the
   * 5-minute (default) write rate; populate per-model when tracking
   * extended-TTL workflows for accurate cost. When undefined,
   * `TokenBudget.estimatedUsdFor` falls back to `cacheWriteUsdPerMTok × 2`.
   */
  cacheWriteUsdPerMTok1h?: number;
}

/**
 * Lightweight registry mapping model IDs to their capability metadata (A4).
 * Adapters use this instead of scattered string prefix checks.
 */
export const ModelRegistry: Record<string, ModelMeta> = {
  // ── Anthropic ────────────────────────────────────────────────────────────
  // Pricing source: https://www.anthropic.com/pricing (verified 2026-06-11).
  // Anthropic prompt-cache: read = 0.1× input price, write = 1.25× input price.
  "claude-opus-4-8": {
    contextWindow: 200_000,
    isReasoning: true,
    supportsReasoningEffort: true,
    supportsVerbosity: false,
    defaultEffort: "standard",
    inputUsdPerMTok: 15,
    outputUsdPerMTok: 75,
    cacheReadUsdPerMTok: 1.5,
    cacheWriteUsdPerMTok: 18.75,
  },
  "claude-opus-4-7": {
    contextWindow: 200_000,
    isReasoning: true,
    supportsReasoningEffort: true,
    supportsVerbosity: false,
    defaultEffort: "standard",
    inputUsdPerMTok: 15,
    outputUsdPerMTok: 75,
    cacheReadUsdPerMTok: 1.5,
    cacheWriteUsdPerMTok: 18.75,
  },
  "claude-sonnet-4-6": {
    contextWindow: 200_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    cacheReadUsdPerMTok: 0.3,
    cacheWriteUsdPerMTok: 3.75,
  },
  "claude-haiku-4-5-20251001": {
    contextWindow: 200_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
    inputUsdPerMTok: 0.8,
    outputUsdPerMTok: 4,
    cacheReadUsdPerMTok: 0.08,
    cacheWriteUsdPerMTok: 1,
  },

  // ── OpenAI GPT-5.x ───────────────────────────────────────────────────────
  // Pricing source: https://openai.com/api/pricing (verified 2026-06-11).
  "gpt-5": {
    contextWindow: 1_000_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: true,
    inputUsdPerMTok: 1.25,
    outputUsdPerMTok: 10,
    cacheReadUsdPerMTok: 0.125,
  },
  "gpt-5.1": {
    contextWindow: 1_000_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: true,
    inputUsdPerMTok: 1.25,
    outputUsdPerMTok: 10,
    cacheReadUsdPerMTok: 0.125,
  },
  "gpt-5.2": {
    contextWindow: 1_000_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: true,
    inputUsdPerMTok: 1.25,
    outputUsdPerMTok: 10,
    cacheReadUsdPerMTok: 0.125,
  },
  "gpt-5.5": {
    contextWindow: 1_000_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: true,
    inputUsdPerMTok: 1.25,
    outputUsdPerMTok: 10,
    cacheReadUsdPerMTok: 0.125,
  },
  "gpt-5-mini": {
    contextWindow: 128_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: true,
    inputUsdPerMTok: 0.25,
    outputUsdPerMTok: 2,
    cacheReadUsdPerMTok: 0.025,
  },
  "gpt-5-nano": {
    contextWindow: 128_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: true,
    inputUsdPerMTok: 0.05,
    outputUsdPerMTok: 0.4,
    cacheReadUsdPerMTok: 0.005,
  },

  // ── OpenAI reasoning (o-series) ──────────────────────────────────────────
  o3: {
    contextWindow: 200_000,
    isReasoning: true,
    supportsReasoningEffort: true,
    supportsVerbosity: false,
    defaultEffort: "medium",
    inputUsdPerMTok: 10,
    outputUsdPerMTok: 40,
    cacheReadUsdPerMTok: 2.5,
  },
  "o4-mini": {
    contextWindow: 200_000,
    isReasoning: true,
    supportsReasoningEffort: true,
    supportsVerbosity: false,
    defaultEffort: "medium",
    inputUsdPerMTok: 1.1,
    outputUsdPerMTok: 4.4,
    cacheReadUsdPerMTok: 0.275,
  },
  "o3-mini": {
    contextWindow: 200_000,
    isReasoning: true,
    supportsReasoningEffort: true,
    supportsVerbosity: false,
    defaultEffort: "medium",
    inputUsdPerMTok: 1.1,
    outputUsdPerMTok: 4.4,
    cacheReadUsdPerMTok: 0.55,
  },

  // ── Legacy GPT-4 ─────────────────────────────────────────────────────────
  "gpt-4o": {
    contextWindow: 128_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
    inputUsdPerMTok: 2.5,
    outputUsdPerMTok: 10,
    cacheReadUsdPerMTok: 1.25,
  },
  "gpt-4o-mini": {
    contextWindow: 128_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
    inputUsdPerMTok: 0.15,
    outputUsdPerMTok: 0.6,
    cacheReadUsdPerMTok: 0.075,
  },
  "gpt-4.1": {
    contextWindow: 1_000_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
    inputUsdPerMTok: 2,
    outputUsdPerMTok: 8,
    cacheReadUsdPerMTok: 0.5,
  },

  // ── Chinese models ───────────────────────────────────────────────────────
  /** @deprecated 2026-07-24 retire — use deepseek-v4-flash or deepseek-v4-pro */
  "deepseek-chat": {
    contextWindow: 64_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  /** @deprecated 2026-07-24 retire — use deepseek-v4-pro */
  "deepseek-reasoner": {
    contextWindow: 64_000,
    isReasoning: true,
    supportsReasoningEffort: true,
    supportsVerbosity: false,
    defaultEffort: "high",
  },
  "deepseek-v4-pro": {
    contextWindow: 128_000,
    isReasoning: true,
    supportsReasoningEffort: true,
    supportsVerbosity: false,
    defaultEffort: "high",
  },
  "deepseek-v4-flash": {
    contextWindow: 128_000,
    isReasoning: true,
    supportsReasoningEffort: true,
    supportsVerbosity: false,
    defaultEffort: "high",
  },
  "moonshot-v1-8k": {
    contextWindow: 8_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "moonshot-v1-32k": {
    contextWindow: 32_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "moonshot-v1-128k": {
    contextWindow: 128_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "kimi-k2-6": {
    contextWindow: 200_000,
    isReasoning: true,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "kimi-k2.6": {
    contextWindow: 262_000,
    isReasoning: true,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "glm-4-plus": {
    contextWindow: 128_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "glm-4-air": {
    contextWindow: 128_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "glm-5": {
    contextWindow: 128_000,
    isReasoning: true,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "glm-4.7": {
    contextWindow: 128_000,
    isReasoning: true,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "glm-4.6": {
    contextWindow: 128_000,
    isReasoning: true,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  /** @deprecated use glm-5 */
  "glm-5-1": {
    contextWindow: 200_000,
    isReasoning: true,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "qwen3-max": {
    contextWindow: 1_000_000,
    isReasoning: true,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "qwen3-plus": {
    contextWindow: 262_000,
    isReasoning: true,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "qwen3-turbo": {
    contextWindow: 1_000_000,
    isReasoning: true,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "minimax-text-01": {
    contextWindow: 1_000_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "MiniMax-M2": {
    contextWindow: 1_000_000,
    isReasoning: true,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "MiniMax-M2.1": {
    contextWindow: 1_000_000,
    isReasoning: true,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "MiniMax-M2.5": {
    contextWindow: 1_000_000,
    isReasoning: true,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "MiniMax-M2.7": {
    contextWindow: 1_000_000,
    isReasoning: true,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "MiniMax-M2.7-highspeed": {
    contextWindow: 1_000_000,
    isReasoning: true,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
  "MiniMax-M3": {
    contextWindow: 1_000_000,
    isReasoning: true,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },

  // ── Doubao / Volcengine Ark ──────────────────────────────────────────────
  "doubao-seed-1-6-251015": {
    contextWindow: 256_000,
    isReasoning: true,
    supportsReasoningEffort: true,
    supportsVerbosity: false,
    defaultEffort: "medium",
  },
  "doubao-seed-1-6-thinking": {
    contextWindow: 256_000,
    isReasoning: true,
    supportsReasoningEffort: true,
    supportsVerbosity: false,
    defaultEffort: "medium",
  },
  "doubao-1-5-thinking-pro": {
    contextWindow: 128_000,
    isReasoning: true,
    supportsReasoningEffort: true,
    supportsVerbosity: false,
    defaultEffort: "medium",
  },
  "doubao-seed-2-0-pro": {
    contextWindow: 256_000,
    isReasoning: true,
    supportsReasoningEffort: true,
    supportsVerbosity: false,
    defaultEffort: "medium",
  },
  "doubao-seed-2-0-lite-260215": {
    contextWindow: 256_000,
    isReasoning: true,
    supportsReasoningEffort: true,
    supportsVerbosity: false,
    defaultEffort: "low",
  },
  "doubao-1-5-pro-32k": {
    contextWindow: 32_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  },
};

/**
 * Look up model metadata from the registry.
 * Falls back to heuristics for unknown models.
 */
export function getModelMeta(modelId: string): ModelMeta {
  if (ModelRegistry[modelId]) return ModelRegistry[modelId] as ModelMeta;
  const id = modelId.toLowerCase();
  if (/^o\d/.test(id)) {
    return {
      contextWindow: 200_000,
      isReasoning: true,
      supportsReasoningEffort: true,
      supportsVerbosity: false,
      defaultEffort: "medium",
    };
  }
  if (id.includes("claude")) {
    const reasoning = id.includes("opus") && !id.includes("4-5") && !id.includes("4-6");
    const meta: ModelMeta = {
      contextWindow: 200_000,
      isReasoning: reasoning,
      supportsReasoningEffort: reasoning,
      supportsVerbosity: false,
    };
    if (reasoning) meta.defaultEffort = "standard";
    return meta;
  }
  if (id.startsWith("doubao")) {
    // Endpoint-ID (ep-xxx) or date-stamped variants — treat as thinking-capable by default.
    return {
      contextWindow: 256_000,
      isReasoning: true,
      supportsReasoningEffort: true,
      supportsVerbosity: false,
      defaultEffort: "medium",
    };
  }
  return {
    contextWindow: 128_000,
    isReasoning: false,
    supportsReasoningEffort: false,
    supportsVerbosity: false,
  };
}

// ── Cache token threshold per model (B1) ─────────────────────────────────────

export const CACHE_MIN_TOKENS: Record<string, number> = {
  "claude-opus-4": 1024,
  "claude-opus-4-5": 4096,
  "claude-opus-4-6": 4096,
  "claude-opus-4-7": 4096,
  "claude-opus-4-8": 4096,
  "claude-sonnet-4": 1024,
  "claude-sonnet-4-5": 1024,
  "claude-sonnet-4-6": 1024,
  "claude-haiku-3": 2048,
  "claude-haiku-4-5": 4096,
};

export function estimateTokens(text: string): number {
  let ascii = 0,
    wide = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) < 128) ascii++;
    else wide++;
  }
  return Math.ceil(ascii / 4 + wide);
}

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
        else if (block.type === "thinking") total += estimateTokens(block.thinking);
      }
    }
  }
  return total;
}

export class TokenBudget {
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  /**
   * Tokens written to the 1-hour TTL cache tier (separate from the
   * default 5-minute tier on Anthropic). Tracked separately because
   * Anthropic prices the 1h tier ~2× the 5m tier — folding it into
   * `cacheWriteTokens` underreports cost by 10–20% on long-context
   * workflows that explicitly opt into 1h TTL. The TokenUsage event
   * already carries this field; we now propagate it. (2026-06-16.)
   */
  cacheWriteTokens1h = 0;
  calls = 0;

  recordUsage(usage: TokenUsage): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    this.cacheWriteTokens1h += usage.cacheWriteTokens1h ?? 0;
    this.calls += 1;
  }

  estimateFallback(messages: ModelMessage[], responseText: string): void {
    this.inputTokens += estimateMessagesTokens(messages);
    this.outputTokens += estimateTokens(responseText);
    this.calls += 1;
  }

  /** Prompt cache hit rate: cacheReadTokens / (inputTokens + cacheReadTokens) */
  get cacheHitRate(): number {
    const total = this.inputTokens + this.cacheReadTokens;
    return total > 0 ? this.cacheReadTokens / total : 0;
  }

  /**
   * Estimated cost in USD.
   *
   * Pass a `modelId` (or pre-resolved `ModelMeta`) to compute the cost using
   * that model's pricing from {@link ModelRegistry}. When omitted — or when
   * the model isn't in the registry — falls back to Sonnet 4.x pricing
   * ($3 input / $15 output per 1M tokens). The fallback is documented as
   * "informational only"; for correct cross-model attribution always pass
   * the modelId you ran with.
   *
   * Cache reads/writes are priced separately: read at 0.1× input price for
   * Anthropic models (and per-model rates for OpenAI). Cache write tokens
   * (when present) are billed at 1.25× input on Anthropic.
   */
  estimatedUsdFor(modelId?: string | ModelMeta): number {
    const meta = typeof modelId === "string" ? ModelRegistry[modelId] : modelId;
    const inputUsd = meta?.inputUsdPerMTok ?? 3;
    const outputUsd = meta?.outputUsdPerMTok ?? 15;
    const cacheReadUsd = meta?.cacheReadUsdPerMTok ?? inputUsd * 0.1;
    const cacheWriteUsd = meta?.cacheWriteUsdPerMTok ?? inputUsd * 1.25;
    // 1-hour TTL cache writes price ~2× the 5-minute tier on Anthropic.
    // ModelMeta carries cacheWriteUsdPerMTok1h when known; fall back to
    // 2× the 5m rate when the registry doesn't have a 1h-specific
    // figure (matches Anthropic's published 2× ratio at 2026-06).
    const cacheWriteUsd1h = meta?.cacheWriteUsdPerMTok1h ?? cacheWriteUsd * 2;
    return (
      (this.inputTokens * inputUsd +
        this.outputTokens * outputUsd +
        this.cacheReadTokens * cacheReadUsd +
        this.cacheWriteTokens * cacheWriteUsd +
        this.cacheWriteTokens1h * cacheWriteUsd1h) /
      1_000_000
    );
  }

  /**
   * @deprecated Use {@link estimatedUsdFor}(modelId) — this getter assumes
   * Sonnet 4.x pricing and ignores the actual model run, which misreports
   * cost for Haiku / Opus / OpenAI runs. Kept for backward compatibility.
   */
  get estimatedUsd(): number {
    return this.estimatedUsdFor();
  }

  get total(): number {
    return this.inputTokens + this.outputTokens;
  }

  toStats() {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      cacheWriteTokens1h: this.cacheWriteTokens1h,
      calls: this.calls,
    };
  }
}

// ── ResourceBudget / EnhancementPolicy (unchanged) ───────────────────────────

export interface ResourceBudget {
  maxTokens?: number;
  maxSteps?: number;
  maxDurationMs?: number;
}

export interface EnhancementPolicy {
  budget?: ResourceBudget;
  selfConsistency?: {
    enabled: boolean;
    n?: number;
    earlyStopThreshold?: number;
  };
  reflectRefine?: {
    enabled: boolean;
    maxCycles?: number;
  };
  budgetForcing?: {
    enabled: boolean;
  };
  parallelForkJoin?: {
    enabled: boolean;
    branches?: number;
    concurrency?: number;
    aggregation?: "summary" | "first";
  };
}
