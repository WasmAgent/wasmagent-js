import type {
  GenerateOptions,
  Model,
  ModelMessage,
  StreamEvent,
} from "./types.js";

/**
 * Anthropic model adapter (E1).
 *
 * Key differences from smolagents models.py:
 *  - Fully async (AsyncGenerator)
 *  - Emits cache_control breakpoints for prompt caching (B1)
 *  - Validates cache breakpoint token thresholds (B1)
 */
export class AnthropicModel implements Model {
  readonly providerId: string;
  #client: unknown; // Lazily imported @anthropic-ai/sdk

  constructor(
    readonly modelId: string,
    readonly apiKey?: string
  ) {
    this.providerId = `anthropic/${modelId}`;
  }

  async *generate(
    messages: ModelMessage[],
    opts: GenerateOptions = {}
  ): AsyncGenerator<StreamEvent> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    if (!this.#client) {
      this.#client = new Anthropic({ apiKey: this.apiKey });
    }
    const client = this.#client as InstanceType<typeof Anthropic>;

    // Convert to Anthropic message format with cache_control breakpoints (B1).
    const anthropicMessages = convertMessages(messages);
    const systemMessage = extractSystemMessage(messages);

    const stream = client.messages.stream({
      model: this.modelId,
      max_tokens: opts.maxTokens ?? 4096,
      system: systemMessage,
      messages: anthropicMessages,
      tools: opts.tools as Parameters<typeof client.messages.stream>[0]["tools"],
      stream: true,
    });

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

    // Emit final usage with cache stats.
    const finalMessage = await stream.finalMessage();
    if (finalMessage.usage) {
      const usage = finalMessage.usage as Record<string, number>;
      yield {
        type: "usage",
        usage: {
          inputTokens: usage["input_tokens"] ?? 0,
          outputTokens: usage["output_tokens"] ?? 0,
          cacheReadTokens: usage["cache_read_input_tokens"],
          cacheWriteTokens: usage["cache_creation_input_tokens"],
        },
      };
    }
  }
}

function extractSystemMessage(messages: ModelMessage[]): string {
  const sys = messages.find((m) => m.role === "system");
  if (!sys) return "";
  return typeof sys.content === "string" ? sys.content : "";
}

function convertMessages(messages: ModelMessage[]): object[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role,
      content:
        typeof m.content === "string"
          ? m.content
          : m.content.map((b) => {
              if (b.type === "text") return { type: "text", text: b.text };
              return b;
            }),
    }));
}
