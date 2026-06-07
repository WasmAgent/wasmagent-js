import type {
  GenerateOptions,
  Model,
  ModelCapabilities,
  ModelMessage,
  StreamEvent,
} from "./types.js";
import type { RetryPolicy } from "./retry.js";
import { withRetryGenerator } from "./retry.js";

export interface OpenAIModelOptions {
  apiKey?: string;
  /** Override the API base URL — enables local endpoints like Ollama/vLLM/llama.cpp. */
  baseURL?: string;
  /** Extra HTTP headers forwarded to every request (e.g. custom auth, routing keys). */
  defaultHeaders?: Record<string, string>;
  samplingParams?: { temperature?: number; seed?: number };
  /** Retry policy for 429/5xx/network errors (C1). */
  retry?: RetryPolicy;
}

/** Canonical OpenAI model IDs. Update here when OpenAI releases new versions. */
export const OpenAIModels = {
  GPT_4O:       "gpt-4o",
  GPT_4O_MINI:  "gpt-4o-mini",
  GPT_4_1:      "gpt-4.1",
  O3:           "o3",
  O4_MINI:      "o4-mini",
} as const;

export type OpenAIModelId = typeof OpenAIModels[keyof typeof OpenAIModels] | (string & {});

/** OpenAI model adapter (E1) — with streaming tool_call support. */
export class OpenAIModel implements Model {
  readonly providerId: string;
  readonly capabilities: ModelCapabilities;
  readonly #opts: OpenAIModelOptions;
  #client: unknown;

  constructor(modelId: string, apiKeyOrOpts?: string | OpenAIModelOptions);
  constructor(
    readonly modelId: string,
    apiKeyOrOpts?: string | OpenAIModelOptions
  ) {
    this.providerId = `openai/${modelId}`;
    this.#opts = typeof apiKeyOrOpts === "string"
      ? { apiKey: apiKeyOrOpts }
      : (apiKeyOrOpts ?? {});
    this.capabilities = {
      metered: !this.#opts.baseURL,
      localEndpoint: !!this.#opts.baseURL,
      supportsGrammar: true,
      supportsBudgetForcing: false,
    };
  }

  get apiKey(): string | undefined { return this.#opts.apiKey; }
  get baseURL(): string | undefined { return this.#opts.baseURL; }

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
    const { default: OpenAI } = await import("openai");
    if (!this.#client) {
      this.#client = new OpenAI({
        apiKey: this.#opts.apiKey,
        ...(this.#opts.baseURL ? { baseURL: this.#opts.baseURL } : {}),
        ...(this.#opts.defaultHeaders ? { defaultHeaders: this.#opts.defaultHeaders } : {}),
      });
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
    if (opts.temperature !== undefined) {
      (params as unknown as Record<string, unknown>)["temperature"] = opts.temperature;
    } else if (this.#opts.samplingParams?.temperature !== undefined) {
      (params as unknown as Record<string, unknown>)["temperature"] = this.#opts.samplingParams.temperature;
    }
    if (opts.topP !== undefined) {
      (params as unknown as Record<string, unknown>)["top_p"] = opts.topP;
    }
    if (opts.seed !== undefined) {
      (params as unknown as Record<string, unknown>)["seed"] = opts.seed;
    } else if (this.#opts.samplingParams?.seed !== undefined) {
      (params as unknown as Record<string, unknown>)["seed"] = this.#opts.samplingParams.seed;
    }
    if (opts.stopSequences && opts.stopSequences.length > 0) {
      (params as unknown as Record<string, unknown>)["stop"] = opts.stopSequences;
    }
    if (opts.responseFormat) {
      // S1: structured output — only applied when capabilities.supportsGrammar is true.
      // OpenAI: pass response_format directly. Callers fall back to S2 when not supported.
      if (this.capabilities.supportsGrammar) {
        if (opts.responseFormat.type === "json_schema") {
          (params as unknown as Record<string, unknown>)["response_format"] = {
            type: "json_schema",
            json_schema: {
              name: opts.responseFormat.name ?? "response",
              schema: opts.responseFormat.schema,
              strict: opts.responseFormat.strict ?? true,
            },
          };
        } else {
          (params as unknown as Record<string, unknown>)["response_format"] = { type: "json_object" };
        }
      }
    }
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
      } else if (choice?.finish_reason === "length") {
        yield { type: "stop", stopReason: "max_tokens" };
      } else if (choice?.finish_reason === "tool_calls") {
        for (const [, tc] of [...toolCallAccum.entries()].sort(([a], [b]) => a - b)) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.arguments || "{}") as Record<string, unknown>;
          } catch {
            console.warn(
              `[OpenAIModel] Failed to parse tool-call arguments for "${tc.name}" (call ${tc.id}). Raw: ${tc.arguments}`
            );
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
