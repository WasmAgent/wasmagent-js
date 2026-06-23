import type { RetryPolicy } from "./retry.js";
import { withRetryGenerator } from "./retry.js";
import type {
  GenerateOptions,
  Model,
  ModelCapabilities,
  ModelMessage,
  StreamEvent,
  TokenUsage,
} from "./types.js";
import { CACHE_MIN_TOKENS, estimateTokens, getModelMeta } from "./types.js";

const ANTHROPIC_MAX_CACHE_BREAKPOINTS = 4;

/**
 * Single source of truth for Anthropic beta header strings.
 * All values are verified against official Anthropic / AWS Bedrock docs.
 * Reference: https://anthropic.com/engineering/advanced-tool-use (2025-11)
 *            https://docs.aws.amazon.com/bedrock/latest/userguide/tool-use.html
 */
export const ANTHROPIC_BETAS = {
  /** 1-hour extended prompt cache TTL. */
  EXTENDED_CACHE_TTL: "extended-cache-ttl-2025-04-11",
  /** Interleaved extended thinking (models ≤4.6). */
  INTERLEAVED_THINKING: "interleaved-thinking-2025-05-14",
  /** Advanced tool use: defer_loading + input_examples + allowed_callers. */
  ADVANCED_TOOL_USE: "advanced-tool-use-2025-11-20",
  /**
   * Server-side code execution sandbox.
   * Verified: anthropic.com/engineering/advanced-tool-use blog (2025-11),
   * litellm & unified.to samples (2025-12 – 2026-03).
   * Previous value "code_execution_20260120" was a fabricated future-dated string.
   */
  CODE_EXECUTION: "code_execution_20250825",
  /**
   * Server-side context management (clear_tool_uses strategy).
   * Verified: AWS Bedrock docs clear_tool_uses_20250919 (2026).
   */
  CONTEXT_MANAGEMENT: "context-management-2025-06-27",
  /** Server-side memory tool. */
  MEMORY_TOOL: "memory-tool-2025-11",
  /** Server-side MCP client connector (defer remote tools without local expansion). */
  MCP_CLIENT: "mcp-client-2025-11-20",
} as const;

/**
 * Trim cache breakpoints so the total never exceeds ANTHROPIC_MAX_CACHE_BREAKPOINTS.
 * System (1) + tools (1) = 2 slots consumed; at most 2 remain for history.
 */
function trimCacheBreakpoints(messages: AnthropicMessage[]): void {
  type Ref = { block: AnthropicTextBlock };
  const refs: Ref[] = [];
  for (const msg of messages) {
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && (block as AnthropicTextBlock).cache_control) {
          refs.push({ block: block as AnthropicTextBlock });
        }
      }
    }
  }
  const historyBudget = ANTHROPIC_MAX_CACHE_BREAKPOINTS - 2;
  if (refs.length <= historyBudget) return;
  for (const { block } of refs.slice(0, refs.length - historyBudget)) {
    delete block.cache_control;
  }
}

export { CACHE_MIN_TOKENS };

/** Canonical Anthropic model IDs. */
export const AnthropicModels = {
  OPUS_LATEST: "claude-opus-4-8",
  SONNET_LATEST: "claude-sonnet-4-6",
  HAIKU_LATEST: "claude-haiku-4-5-20251001",
} as const;

export type AnthropicModelId =
  | (typeof AnthropicModels)[keyof typeof AnthropicModels]
  | (string & {});

/**
 * Exhaustive whitelist of Anthropic model IDs that require the legacy
 * `budget_tokens` parameter instead of adaptive thinking.
 *
 * Safety direction: unknown / new models default to adaptive thinking.
 * Only add a model here if it is confirmed to support ONLY `budget_tokens`
 * (i.e. it predates the adaptive-thinking API introduced in claude-*-4-7).
 * Do NOT add Claude 5 or later models here.
 */
const _LEGACY_BUDGET_TOKENS_MODELS = new Set([
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-sonnet-4-5",
]);

/**
 * Returns true when the model supports the adaptive-thinking parameter
 * (i.e. it is NOT in the legacy budget_tokens whitelist).
 *
 * Defaults to true for any model not explicitly listed as legacy, so that
 * Claude 5 and future models are handled correctly without a regex update.
 */
function isAdaptiveThinkingModel(modelId: string): boolean {
  return !_LEGACY_BUDGET_TOKENS_MODELS.has(modelId);
}

export interface AnthropicModelOptions {
  apiKey?: string;
  baseURL?: string;
  retry?: RetryPolicy;
  /**
   * Use Anthropic's server-side context management (experimental).
   * When true: attaches the context-management beta and skips local
   * MessageAssembler.editToolResults() — the server manages context trimming.
   * Mutually exclusive with local context editing.
   */
  serverSideContextManagement?: boolean;
  /**
   * Use Anthropic's server-side memory tool (experimental).
   * When true: attaches the memory-tool beta and skips local memory tool injection.
   * Mutually exclusive with createMemoryTool() usage.
   */
  serverSideMemory?: boolean;
  /**
   * A1: Variant of the Tool Search server tool to inject when deferred tools are present.
   * - "regex" (default): tool_search_tool_regex_20251119
   * - "bm25": tool_search_tool_bm25_20251119
   * Only relevant when at least one registered tool has deferLoading: true.
   */
  toolSearchVariant?: "regex" | "bm25";
}

export class AnthropicModel implements Model {
  readonly providerId: string;
  readonly capabilities: ModelCapabilities;
  #client: unknown;
  readonly #opts: AnthropicModelOptions;

  constructor(
    readonly modelId: AnthropicModelId,
    optsOrApiKey?: AnthropicModelOptions | string
  ) {
    this.providerId = `anthropic/${modelId}`;
    if (typeof optsOrApiKey === "string") {
      this.#opts = { apiKey: optsOrApiKey };
    } else {
      this.#opts = optsOrApiKey ?? {};
    }
    const meta = getModelMeta(modelId);
    this.capabilities = {
      metered: true,
      supportsGrammar: true,
      supportsBudgetForcing: true,
      supportsReasoningEffort: meta.supportsReasoningEffort,
      supportsVerbosity: false,
      cacheStrategy: "anthropic-explicit",
      contextWindow: meta.contextWindow,
    };
  }

  get apiKey(): string | undefined {
    return this.#opts.apiKey;
  }

  get cacheMinTokens(): number {
    if (CACHE_MIN_TOKENS[this.modelId] !== undefined)
      return CACHE_MIN_TOKENS[this.modelId] as number;
    const id = this.modelId.toLowerCase();
    if (id.includes("opus")) return 4096;
    if (id.includes("haiku")) return 2048;
    return 1024;
  }

  async *generate(
    messages: ModelMessage[],
    opts: GenerateOptions = {}
  ): AsyncGenerator<StreamEvent> {
    yield* withRetryGenerator(() => this.#doGenerate(messages, opts), this.#opts.retry);
  }

  async *#doGenerate(
    messages: ModelMessage[],
    opts: GenerateOptions = {}
  ): AsyncGenerator<StreamEvent> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    if (!this.#client) {
      this.#client = new Anthropic({
        apiKey: this.#opts.apiKey,
        ...(this.#opts.baseURL ? { baseURL: this.#opts.baseURL } : {}),
      });
    }
    const client = this.#client as InstanceType<typeof Anthropic>;

    const systemMessage = extractSystemMessage(messages);
    const estimatedSystemTokens = estimateTokens(systemMessage);
    const shouldCache = estimatedSystemTokens >= this.cacheMinTokens;

    const anthropicMessages = convertMessages(messages, shouldCache, this.cacheMinTokens);
    trimCacheBreakpoints(anthropicMessages as AnthropicMessage[]);
    const trimmedMessages = anthropicMessages as Parameters<
      typeof client.messages.stream
    >[0]["messages"];

    const has1hTtl = messages.some((m) => m.cacheBreakpoint?.ttl === "1h");

    const systemParam = systemMessage
      ? [
          {
            type: "text" as const,
            text: systemMessage,
            ...(shouldCache ? { cache_control: { type: "ephemeral" as const } } : {}),
          },
        ]
      : undefined;

    type StreamParams = Parameters<typeof client.messages.stream>[0];
    const streamParams: StreamParams = {
      model: this.modelId,
      max_tokens: opts.maxTokens ?? 4096,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.topP !== undefined ? { top_p: opts.topP } : {}),
      ...(opts.stopSequences && opts.stopSequences.length > 0
        ? { stop_sequences: opts.stopSequences }
        : {}),
      ...(systemParam ? { system: systemParam } : {}),
      messages: trimmedMessages,
    };

    const betas: string[] = [];
    if (has1hTtl) betas.push(ANTHROPIC_BETAS.EXTENDED_CACHE_TTL);

    // A1: Adaptive thinking / extended thinking support.
    if (opts.thinking && opts.thinking.mode !== "off") {
      const thinkingParam = this.#buildThinkingParam(opts);
      if (thinkingParam) {
        (streamParams as unknown as Record<string, unknown>).thinking = thinkingParam;
        // Adaptive thinking requires interleaved-thinking beta for ≤4.6 models.
        if (!isAdaptiveThinkingModel(this.modelId)) {
          betas.push(ANTHROPIC_BETAS.INTERLEAVED_THINKING);
        }
        // When thinking is enabled, temperature must be 1 (Anthropic requirement).
        if (opts.temperature === undefined || opts.temperature !== 1) {
          (streamParams as unknown as Record<string, unknown>).temperature = 1;
        }
      }
    }

    // A3: Structured output via forced single-tool invocation.
    let structuredOutputToolName: string | undefined;
    if (opts.responseFormat?.type === "json_schema") {
      structuredOutputToolName = opts.responseFormat.name ?? "structured_output";
      const syntheticTool = {
        name: structuredOutputToolName,
        description: "Return the structured response conforming to the given schema.",
        input_schema: opts.responseFormat.schema,
      };
      const existingTools =
        ((streamParams as unknown as Record<string, unknown>).tools as unknown[]) ?? [];
      (streamParams as unknown as Record<string, unknown>).tools = [
        ...existingTools,
        syntheticTool,
      ];
      (streamParams as unknown as Record<string, unknown>).tool_choice = {
        type: "tool",
        name: structuredOutputToolName,
      };
    } else if (opts.disableParallelToolUse) {
      // Prevent parallel tool calls — model calls one tool at a time.
      // Fixes empty-args bug where batched parallel calls have truncated JSON.
      (streamParams as unknown as Record<string, unknown>).tool_choice = {
        type: "auto",
        disable_parallel_tool_use: true,
      };
    } else if (opts.responseFormat?.type === "json_object") {
      // R4: Anthropic has no native json_object mode. Use system instruction + assistant pre-fill.
      // Callers should prefer json_schema for reliable output.
      const jsonInstruction =
        "Respond ONLY with a valid JSON object. Do not include any text outside the JSON.";
      if (systemParam && systemParam.length > 0 && systemParam[0]) {
        const existing = systemParam[0].text;
        systemParam[0] = {
          type: "text" as const,
          text: existing ? `${existing}\n\n${jsonInstruction}` : jsonInstruction,
          ...(systemParam[0].cache_control ? { cache_control: systemParam[0].cache_control } : {}),
        };
      } else {
        (streamParams as unknown as Record<string, unknown>).system = [
          { type: "text" as const, text: jsonInstruction },
        ];
      }
    }

    if (opts.tools && opts.tools.length > 0) {
      const allTools = opts.tools as Array<Record<string, unknown>>;
      const hasDeferredTools = allTools.some((t) => t.deferLoading === true);
      const hasPtcTools = allTools.some((t) => Array.isArray(t.allowed_callers));

      if (hasDeferredTools) {
        betas.push(ANTHROPIC_BETAS.ADVANCED_TOOL_USE);
      }
      if (hasPtcTools) {
        // PTC (programmatic tool calling) uses the code_execution sandbox beta.
        betas.push(ANTHROPIC_BETAS.CODE_EXECUTION);
      }

      // A1: When deferred tools are present, inject the tool_search server tool so
      // the model can retrieve them on demand. Without this, deferred tools are
      // unreachable — the model has no mechanism to load them.
      // Per Anthropic docs (advanced-tool-use, 2025-11): tool_search_tool_* MUST be
      // in the tools array alongside defer_loading:true tool definitions.
      const toolSearchVariant = this.#opts.toolSearchVariant;
      const toolSearchType =
        toolSearchVariant === "bm25"
          ? "tool_search_tool_bm25_20251119"
          : "tool_search_tool_regex_20251119";

      // Build wire tools:
      //  - Non-deferred tools: included as-is (strip deferLoading field if present).
      //  - Deferred tools: included with defer_loading:true (rename deferLoading → defer_loading).
      //  - tool_search tool: prepended when any deferred tools exist.
      const wireTools: Array<Record<string, unknown>> = [];

      if (hasDeferredTools) {
        wireTools.push({ type: toolSearchType, name: toolSearchType.replace(/_20\d{6}$/, "") });
      }

      // Find the last non-deferred tool index for cache_control placement.
      // Anthropic's advanced-tool-use beta does not support cache_control on deferred tools.
      let lastEagerIdx = -1;
      for (let i = allTools.length - 1; i >= 0; i--) {
        if (allTools[i]?.deferLoading !== true) {
          lastEagerIdx = i;
          break;
        }
      }

      for (let i = 0; i < allTools.length; i++) {
        const t = allTools[i] as Record<string, unknown>;
        const isDeferred = t.deferLoading === true;
        const { deferLoading: _dl, ...rest } = t;
        const wire: Record<string, unknown> = { ...rest };
        if (isDeferred) {
          wire.defer_loading = true;
        }
        // Cache control on the last non-deferred tool for prompt-cache efficiency.
        if (i === lastEagerIdx) {
          wire.cache_control = { type: "ephemeral" };
        }
        wireTools.push(wire);
      }

      if (wireTools.length > 0) {
        // Merge with any synthetic structured-output tool already added.
        const existing =
          ((streamParams as unknown as Record<string, unknown>).tools as unknown[]) ?? [];
        const syntheticCount = structuredOutputToolName ? 1 : 0;
        const baseTools = (existing as unknown[]).slice(0, syntheticCount);
        (streamParams as unknown as Record<string, unknown>).tools = [...baseTools, ...wireTools];
      }
    }

    // D1: server-side context management / memory betas.
    if (this.#opts.serverSideContextManagement) betas.push(ANTHROPIC_BETAS.CONTEXT_MANAGEMENT);
    if (this.#opts.serverSideMemory) betas.push(ANTHROPIC_BETAS.MEMORY_TOOL);

    if (betas.length > 0) {
      (streamParams as unknown as Record<string, unknown>).betas = betas;
    }

    const stream = client.messages.stream(streamParams);

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text_delta", delta: event.delta.text };
      } else if (
        event.type === "content_block_delta" &&
        (event.delta as unknown as Record<string, unknown>).type === "thinking_delta"
      ) {
        const thinkingDelta = (event.delta as unknown as Record<string, unknown>).thinking as
          | string
          | undefined;
        if (thinkingDelta) yield { type: "thinking_delta", delta: thinkingDelta };
      } else if (event.type === "message_stop") {
        // Stop is deferred until after tool_call events are emitted from finalMessage below.
      }
    }

    const finalMessage = await stream.finalMessage();

    // Emit tool_use blocks — but skip the synthetic structured-output tool.
    for (const block of finalMessage.content) {
      if (block.type === "tool_use") {
        if (block.name === structuredOutputToolName) {
          // Emit the structured result as text_delta so callers see it uniformly.
          yield {
            type: "text_delta",
            delta: JSON.stringify(block.input),
          };
        } else {
          yield {
            type: "tool_call",
            toolCall: {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            },
          };
        }
      }
    }

    // Emit stop after tool_call events, using the real stop_reason from finalMessage.
    const stopReason =
      finalMessage.stop_reason === "tool_use"
        ? "tool_use"
        : finalMessage.stop_reason === "max_tokens"
          ? "max_tokens"
          : finalMessage.stop_reason === "stop_sequence"
            ? "stop_sequence"
            : "end_turn";
    yield { type: "stop", stopReason };

    if (finalMessage.usage) {
      const u = finalMessage.usage;
      const usage: TokenUsage = {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
      };
      const uAny = u as unknown as Record<string, unknown>;
      const cacheRead = uAny.cache_read_input_tokens;
      const cacheWrite = uAny.cache_creation_input_tokens;
      if (typeof cacheRead === "number") usage.cacheReadTokens = cacheRead;
      if (typeof cacheWrite === "number") usage.cacheWriteTokens = cacheWrite;
      const cache5mRead = uAny.ephemeral_5m_input_tokens;
      const cache1hRead = uAny.ephemeral_1h_input_tokens;
      const cacheCreation = uAny.cache_creation as Record<string, unknown> | undefined;
      if (typeof cache5mRead === "number")
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + cache5mRead;
      if (typeof cache1hRead === "number") usage.cacheReadTokens1h = cache1hRead;
      if (typeof cacheCreation?.ephemeral_1h_input_tokens === "number") {
        usage.cacheWriteTokens1h = cacheCreation.ephemeral_1h_input_tokens as number;
      }
      // Thinking token usage.
      const thinkTokens = uAny.thinking_tokens;
      if (typeof thinkTokens === "number") usage.thinkingTokens = thinkTokens;
      yield { type: "usage", usage };
    }
  }

  /**
   * Build the `thinking` parameter for the Anthropic API.
   * Handles adaptive thinking (default for all models not in _LEGACY_BUDGET_TOKENS_MODELS)
   * vs legacy budget_tokens (only for models explicitly listed in that whitelist).
   */
  #buildThinkingParam(opts: GenerateOptions): Record<string, unknown> | null {
    const t = opts.thinking;
    if (!t || t.mode === "off") return null;

    if (t.mode === "enabled") {
      // Legacy budget_tokens mode — only valid for models in _LEGACY_BUDGET_TOKENS_MODELS.
      if (isAdaptiveThinkingModel(this.modelId)) {
        throw new Error(
          `[AnthropicModel] thinking.mode="enabled" with budgetTokens is not supported on ` +
            `${this.modelId} (≥4.7). Use thinking.mode="adaptive" with an effort level instead. ` +
            `The budget_tokens parameter was deprecated and returns HTTP 400 on Anthropic ≥4.7.`
        );
      }
      return { type: "enabled", budget_tokens: t.budgetTokens ?? 8000 };
    }

    // mode === "adaptive"
    const effort = t.effort ?? getModelMeta(this.modelId).defaultEffort ?? "standard";
    return { type: "adaptive", effort };
  }
}

// ── Message converters ────────────────────────────────────────────────────────

function extractSystemMessage(messages: ModelMessage[]): string {
  const sys = messages.find((m) => m.role === "system");
  if (!sys) return "";
  return typeof sys.content === "string" ? sys.content : "";
}

type AnthropicCacheControl = { type: "ephemeral"; ttl?: "5m" | "1h" };

interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
}

interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: true;
  cache_control?: AnthropicCacheControl;
}

type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

type AnthropicContent = string | AnthropicBlock[];

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContent;
}

function convertMessages(
  messages: ModelMessage[],
  shouldCache: boolean,
  cacheMinTokens: number
): AnthropicMessage[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const role = m.role === "assistant" ? ("assistant" as const) : ("user" as const);

      if (typeof m.content === "string") {
        const chunkTokens = estimateTokens(m.content);
        if (m.cacheBreakpoint && shouldCache && chunkTokens >= cacheMinTokens) {
          const cc: AnthropicCacheControl = { type: "ephemeral" };
          if (m.cacheBreakpoint.ttl) cc.ttl = m.cacheBreakpoint.ttl;
          return {
            role,
            content: [{ type: "text" as const, text: m.content, cache_control: cc }],
          };
        }
        return { role, content: m.content };
      }

      const blocks: AnthropicBlock[] = m.content
        .map((b): AnthropicBlock | null => {
          if (b.type === "text") return { type: "text", text: b.text };
          if (b.type === "thinking") {
            // Preserve thinking blocks in multi-turn to avoid cache invalidation (A1).
            return {
              type: "thinking",
              thinking: b.thinking,
              ...(b.signature ? { signature: b.signature } : {}),
            };
          }
          if (b.type === "tool_use") {
            return { type: "tool_use", id: b.id, name: b.name, input: b.input };
          }
          if (b.type === "tool_result") {
            const block: AnthropicToolResultBlock = {
              type: "tool_result",
              tool_use_id: b.toolUseId,
              content: b.content || "Tool execution failed with no output.",
            };
            if (b.isError) block.is_error = true;
            return block;
          }
          return null;
        })
        .filter((b): b is AnthropicBlock => b !== null);

      if (m.cacheBreakpoint && shouldCache && blocks.length > 0) {
        const textBlocks = blocks.filter((b): b is AnthropicTextBlock => b.type === "text");
        const textContent = textBlocks.map((b) => b.text).join("");
        if (textBlocks.length > 0 && estimateTokens(textContent) >= cacheMinTokens) {
          const lastTextBlock = textBlocks[textBlocks.length - 1] as AnthropicTextBlock;
          const cc: AnthropicCacheControl = { type: "ephemeral" };
          if (m.cacheBreakpoint.ttl) cc.ttl = m.cacheBreakpoint.ttl;
          lastTextBlock.cache_control = cc;
        }
      }

      return { role, content: blocks.length > 0 ? blocks : "" };
    });
}
