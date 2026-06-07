import type {
  GenerateOptions,
  Model,
  ModelCapabilities,
  ModelMessage,
  StreamEvent,
  TokenUsage,
} from "./types.js";
import { CACHE_MIN_TOKENS, estimateTokens } from "./types.js";

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

    const anthropicMessages = convertMessages(messages, shouldCache) as Parameters<
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
      messages: anthropicMessages,
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

function convertMessages(messages: ModelMessage[], shouldCache: boolean): AnthropicMessage[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const role = m.role === "assistant" ? "assistant" as const : "user" as const;

      if (typeof m.content === "string") {
        // Apply cache breakpoint only when the prefix is large enough (B1).
        if (m.cacheBreakpoint && shouldCache) {
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

      // Apply cache breakpoint to last text block in the sequence (B1).
      if (m.cacheBreakpoint && shouldCache && blocks.length > 0) {
        const lastText = [...blocks].reverse().find((b): b is AnthropicTextBlock => b.type === "text");
        if (lastText) lastText.cache_control = { type: "ephemeral" };
      }

      return { role, content: blocks.length > 0 ? blocks : "" };
    });
}
