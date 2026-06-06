import type {
  GenerateOptions,
  Model,
  ModelMessage,
  StreamEvent,
} from "@agentkit-js/core/models";

/** OpenAI model adapter (E1) — with streaming tool_call support. */
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

    const openAiMessages = convertMessages(messages) as Parameters<
      typeof client.chat.completions.create
    >[0]["messages"];

    type CreateParams = Parameters<typeof client.chat.completions.create>[0];
    const params: CreateParams = {
      model: this.modelId,
      max_tokens: opts.maxTokens ?? 4096,
      messages: openAiMessages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (opts.tools && opts.tools.length > 0) {
      (params as unknown as Record<string, unknown>)["tools"] = opts.tools.map((t) => ({
        type: "function",
        function: t,
      }));
      (params as unknown as Record<string, unknown>)["tool_choice"] = "auto";
    }

    type OAIChunk = import("openai/resources/index.js").ChatCompletionChunk;
    const stream = (await client.chat.completions.create(params)) as unknown as AsyncIterable<OAIChunk>;

    // Accumulate streamed tool_call deltas — OpenAI streams them across multiple chunks.
    const toolCallAccum = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];

      if (choice?.delta.content) {
        yield { type: "text_delta", delta: choice.delta.content };
      }

      if (choice?.delta.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallAccum.has(idx)) {
            toolCallAccum.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" });
          }
          const accum = toolCallAccum.get(idx)!;
          if (tc.id) accum.id = tc.id;
          if (tc.function?.name) accum.name = tc.function.name;
          if (tc.function?.arguments) accum.arguments += tc.function.arguments;
        }
      }

      if (choice?.finish_reason === "stop") {
        yield { type: "stop", stopReason: "end_turn" };
      } else if (choice?.finish_reason === "tool_calls") {
        for (const [, tc] of [...toolCallAccum.entries()].sort(([a], [b]) => a - b)) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.arguments || "{}") as Record<string, unknown>;
          } catch {
            input = { _raw: tc.arguments };
          }
          yield {
            type: "tool_call",
            toolCall: { type: "tool_use", id: tc.id, name: tc.name, input },
          };
        }
        yield { type: "stop", stopReason: "tool_use" };
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

interface OpenAITextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIAssistantToolMessage {
  role: "assistant";
  content: string | null;
  tool_calls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface OpenAIToolResultMessage {
  role: "tool";
  content: string;
  tool_call_id: string;
}

type OpenAIMessage = OpenAITextMessage | OpenAIAssistantToolMessage | OpenAIToolResultMessage;

function convertMessages(messages: ModelMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      result.push({ role: "system", content: typeof m.content === "string" ? m.content : "" });
      continue;
    }

    if (typeof m.content === "string") {
      if (m.role === "user" || m.role === "assistant") {
        result.push({ role: m.role, content: m.content });
      }
      continue;
    }

    // Structured content blocks.
    const toolCalls: OpenAIAssistantToolMessage["tool_calls"] = [];
    const textParts: string[] = [];

    for (const block of m.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use" && m.role === "assistant") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      } else if (block.type === "tool_result") {
        result.push({ role: "tool", content: block.content, tool_call_id: block.toolUseId });
      }
    }

    if (toolCalls.length > 0) {
      result.push({
        role: "assistant",
        content: textParts.join("\n") || null,
        tool_calls: toolCalls,
      });
    } else if (textParts.length > 0 && (m.role === "user" || m.role === "assistant")) {
      result.push({ role: m.role, content: textParts.join("\n") });
    }
  }

  return result;
}
