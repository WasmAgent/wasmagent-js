import type {
  GenerateOptions,
  Model,
  ModelCapabilities,
  ModelMessage,
  StreamEvent,
  TokenUsage,
} from "./types.js";
import { CACHE_MIN_TOKENS, estimateTokens } from "./types.js";
import type { RetryPolicy } from "./retry.js";
import { withRetryGenerator } from "./retry.js";

/**
 * Anthropic hard limit: max 4 cache_control breakpoints per request.
 * Exceeding this causes the API to silently drop all but the last 4,
 * which evicts the high-value system/tools prefix from the cache.
 *
 * Strategy: always reserve 1 slot for system, 1 for tools (last), leaving
 * at most 2 slots for history chunks. When there are more than 2 history
 * breakpoints, keep only the newest ones (they cover the longest prefix).
 */
const ANTHROPIC_MAX_CACHE_BREAKPOINTS = 4;

/**
 * Trim cache breakpoints in a converted Anthropic message array so the total
 * count never exceeds ANTHROPIC_MAX_CACHE_BREAKPOINTS.
 *
 * The system message and tools are always assigned slots 0 and 1 respectively
 * (via the systemParam / tools array in the caller). The remaining 2 slots are
 * given to the *newest* (last-occurring) history breakpoints so the longest
 * stable prefix wins.
 *
 * This function operates on the already-converted AnthropicMessage[] and
 * removes cache_control from the oldest blocks when over-budget.
 */
function trimCacheBreakpoints(messages: AnthropicMessage[]): void {
  // Collect indices (into messages[]) of text blocks that carry cache_control.
  type Ref = { msgIdx: number; block: AnthropicTextBlock };
  const refs: Ref[] = [];
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i]!.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && (block as AnthropicTextBlock).cache_control) {
          refs.push({ msgIdx: i, block: block as AnthropicTextBlock });
        }
      }
    }
  }
  // system (1) + tools (1) = 2 slots already consumed; 2 remain for history.
  const historyBudget = ANTHROPIC_MAX_CACHE_BREAKPOINTS - 2;
  if (refs.length <= historyBudget) return;
  // Drop oldest breakpoints (keep the newest historyBudget ones).
  const toDrop = refs.slice(0, refs.length - historyBudget);
  for (const { block } of toDrop) {
    delete block.cache_control;
  }
}

export { CACHE_MIN_TOKENS };

/** Canonical Anthropic model IDs. Update here when Anthropic releases new versions. */
export const AnthropicModels = {
  CLAUDE_OPUS_4:    "claude-opus-4-8",
  CLAUDE_SONNET_4:  "claude-sonnet-4-6",
  CLAUDE_HAIKU_4:   "claude-haiku-4-5-20251001",
} as const;

export type AnthropicModelId = typeof AnthropicModels[keyof typeof AnthropicModels] | (string & {});

export interface AnthropicModelOptions {
  apiKey?: string;
  baseURL?: string;
  /** Retry policy for 429/5xx/network errors (C1). */
  retry?: RetryPolicy;
}

export class AnthropicModel implements Model {
  readonly providerId: string;
  readonly capabilities: ModelCapabilities = {
    metered: true,
    supportsGrammar: false,
    supportsBudgetForcing: true,
  };
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
  }

  get apiKey(): string | undefined {
    return this.#opts.apiKey;
  }

  /**
   * The minimum token count the system message must reach before cache_control
   * breakpoints are injected (B1).
   *
   * Lookup order:
   *   1. Exact match in CACHE_MIN_TOKENS (known models).
   *   2. Tier inference from model ID substring ("opus" → 4096, "haiku" → 2048, "sonnet" → 1024).
   *   3. Conservative default of 1024 for unknown future models.
   */
  get cacheMinTokens(): number {
    if (CACHE_MIN_TOKENS[this.modelId] !== undefined) return CACHE_MIN_TOKENS[this.modelId]!;
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
    // B1: validate token threshold before injecting cache breakpoints.
    // estimateTokens uses character-category weighting (ASCII /4, non-ASCII /1.5)
    // so CJK/Unicode-heavy prompts are not under-counted like a flat length/4 would.
    const estimatedSystemTokens = estimateTokens(systemMessage);
    const shouldCache = estimatedSystemTokens >= this.cacheMinTokens;

    const anthropicMessages = convertMessages(messages, shouldCache, this.cacheMinTokens);
    // A2: Trim history breakpoints so total cache_control blocks ≤ 4 (system + tools
    // already occupy 2 slots; at most 2 more are allowed for history chunks).
    trimCacheBreakpoints(anthropicMessages as AnthropicMessage[]);
    const trimmedMessages = anthropicMessages as Parameters<
      typeof client.messages.stream
    >[0]["messages"];

    // System message gets cache_control only when estimated tokens >= threshold (B1).
    const systemParam = systemMessage
      ? [{
          type: "text" as const,
          text: systemMessage,
          ...(shouldCache ? { cache_control: { type: "ephemeral" as const } } : {}),
        }]
      : undefined;

    type StreamParams = Parameters<typeof client.messages.stream>[0];
    const streamParams: StreamParams = {
      model: this.modelId,
      max_tokens: opts.maxTokens ?? 4096,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.topP !== undefined ? { top_p: opts.topP } : {}),
      ...(opts.stopSequences && opts.stopSequences.length > 0 ? { stop_sequences: opts.stopSequences } : {}),
      ...(systemParam ? { system: systemParam } : {}),
      messages: trimmedMessages,
    };
    if (opts.tools && opts.tools.length > 0) {
      // Mark the last tool with cache_control so tools array is cached as a prefix (B1).
      const tools = opts.tools.map((t, i) =>
        i === opts.tools!.length - 1
          ? { ...t as object, cache_control: { type: "ephemeral" as const } }
          : t
      );
      (streamParams as unknown as Record<string, unknown>)["tools"] = tools;
    }
    const stream = client.messages.stream(streamParams);

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield { type: "text_delta", delta: event.delta.text };
      } else if (event.type === "message_delta" && event.usage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: 0,
            outputTokens: event.usage.output_tokens,
          },
        };
      } else if (event.type === "message_stop") {
        yield { type: "stop", stopReason: "end_turn" };
      }
    }

    const finalMessage = await stream.finalMessage();

    // Emit any tool_use blocks from the final message.
    for (const block of finalMessage.content) {
      if (block.type === "tool_use") {
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

    if (finalMessage.usage) {
      const u = finalMessage.usage;
      const usage: TokenUsage = {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
      };
      // Cache stats are optional fields — only include when present (B1).
      const uAny = u as unknown as Record<string, unknown>;
      const cacheRead = uAny["cache_read_input_tokens"];
      const cacheWrite = uAny["cache_creation_input_tokens"];
      if (typeof cacheRead === "number") usage.cacheReadTokens = cacheRead;
      if (typeof cacheWrite === "number") usage.cacheWriteTokens = cacheWrite;
      yield { type: "usage", usage };
    }
  }
}

function extractSystemMessage(messages: ModelMessage[]): string {
  const sys = messages.find((m) => m.role === "system");
  if (!sys) return "";
  return typeof sys.content === "string" ? sys.content : "";
}

type AnthropicCacheControl = { type: "ephemeral" };

interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
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
  /** Tells the model this tool_result represents an error (Anthropic is_error). */
  is_error?: true;
}

type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;
type AnthropicContent = string | AnthropicBlock[];

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContent;
}

function convertMessages(messages: ModelMessage[], shouldCache: boolean, cacheMinTokens: number): AnthropicMessage[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const role = m.role === "assistant" ? "assistant" as const : "user" as const;

      if (typeof m.content === "string") {
        // A2: guard — only inject breakpoint when the chunk is large enough to be cached.
        const chunkTokens = estimateTokens(m.content);
        if (m.cacheBreakpoint && shouldCache && chunkTokens >= cacheMinTokens) {
          return {
            role,
            content: [
              {
                type: "text" as const,
                text: m.content,
                cache_control: { type: "ephemeral" as const },
              },
            ],
          };
        }
        return { role, content: m.content };
      }

      // Structured content blocks — map all supported types.
      const blocks: AnthropicBlock[] = m.content
        .map((b): AnthropicBlock | null => {
          if (b.type === "text") return { type: "text", text: b.text };
          if (b.type === "tool_use") {
            return {
              type: "tool_use",
              id: b.id,
              name: b.name,
              input: b.input,
            };
          }
          if (b.type === "tool_result") {
            const block: AnthropicToolResultBlock = {
              type: "tool_result",
              tool_use_id: b.toolUseId,
              // Anthropic requires non-empty content when is_error is true.
              content: b.content || "Tool execution failed with no output.",
            };
            if (b.isError) block.is_error = true;
            return block;
          }
          return null;
        })
        .filter((b): b is AnthropicBlock => b !== null);

      // A2: guard — only inject breakpoint when the chunk text is large enough.
      if (m.cacheBreakpoint && shouldCache && blocks.length > 0) {
        const textContent = blocks
          .filter((b): b is AnthropicTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (estimateTokens(textContent) >= cacheMinTokens) {
          const lastText = [...blocks].reverse().find((b): b is AnthropicTextBlock => b.type === "text");
          if (lastText) lastText.cache_control = { type: "ephemeral" };
        }
      }

      return { role, content: blocks.length > 0 ? blocks : "" };
    });
}
