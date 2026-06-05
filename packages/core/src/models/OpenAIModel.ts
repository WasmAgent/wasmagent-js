import type {
  GenerateOptions,
  Model,
  ModelMessage,
  StreamEvent,
} from "./types.js";

/** OpenAI model adapter (E1). */
export class OpenAIModel implements Model {
  readonly providerId: string;
  #client: unknown;

  constructor(
    readonly modelId: string,
    readonly apiKey?: string
  ) {
    this.providerId = `openai/${modelId}`;
  }

  async *generate(
    messages: ModelMessage[],
    opts: GenerateOptions = {}
  ): AsyncGenerator<StreamEvent> {
    const { default: OpenAI } = await import("openai");
    if (!this.#client) {
      this.#client = new OpenAI({ apiKey: this.apiKey });
    }
    const client = this.#client as InstanceType<typeof OpenAI>;

    const stream = await client.chat.completions.create({
      model: this.modelId,
      max_tokens: opts.maxTokens ?? 4096,
      messages: messages
        .filter((m) => m.role !== "tool")
        .map((m) => ({
          role: m.role as "system" | "user" | "assistant",
          content: typeof m.content === "string" ? m.content : "",
        })),
      stream: true,
    });

    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.delta.content) {
        yield { type: "text_delta", delta: choice.delta.content };
      }
      if (choice.finish_reason === "stop") {
        yield { type: "stop", stopReason: "end_turn" };
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }
    }

    if (inputTokens > 0 || outputTokens > 0) {
      yield { type: "usage", usage: { inputTokens, outputTokens } };
    }
  }
}
