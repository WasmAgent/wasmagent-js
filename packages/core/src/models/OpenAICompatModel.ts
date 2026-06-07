import type {
  GenerateOptions,
  Model,
  ModelCapabilities,
  ModelMessage,
  StreamEvent,
} from "./types.js";
import { getModelMeta } from "./types.js";
import type { RetryPolicy } from "./retry.js";
import { withRetryGenerator } from "./retry.js";

/**
 * Base class for OpenAI Chat Completions-compatible endpoints (B1).
 *
 * Chinese providers (DeepSeek, Kimi/Moonshot, GLM/Zhipu, Qwen/DashScope, MiniMax)
 * expose OpenAI-compatible /chat/completions but differ in:
 *  - How they return reasoning/thinking text (non-standard fields).
 *  - Whether they accept/ignore reasoning parameters.
 *
 * Subclasses override mapReasoningField() and mapRequestParams() to handle
 * provider-specific differences without duplicating retry/stream logic.
 */
export abstract class OpenAICompatModel implements Model {
  readonly providerId: string;
  readonly capabilities: ModelCapabilities;
  readonly #opts: OpenAICompatModelOptions;
  #client: unknown;

  constructor(
    readonly modelId: string,
    baseUrl: string,
    opts: OpenAICompatModelOptions = {}
  ) {
    this.providerId = `compat/${modelId}`;
    this.#opts = opts;
    const meta = getModelMeta(modelId);
    const caps: ModelCapabilities = {
      metered: true,
      localEndpoint: false,
      supportsGrammar: true,
      supportsBudgetForcing: false,
      supportsReasoningEffort: false,
      supportsVerbosity: false,
      cacheStrategy: "auto-prefix",
      contextWindow: meta.contextWindow,
      ...this.extraCapabilities(),
    };
    if (opts.reasoningContentField !== undefined) {
      caps.reasoningContentField = opts.reasoningContentField;
    }
    this.capabilities = caps;
    // Store baseURL on opts for client construction.
    (this.#opts as Record<string, unknown>)["_baseURL"] = baseUrl;
  }

  /** Subclasses can override to add extra capability flags. */
  protected extraCapabilities(): Partial<ModelCapabilities> {
    return {};
  }

  /**
   * Map a raw API chunk to extract reasoning text from a provider-specific field.
   * Return undefined if this chunk contains no reasoning content.
   */
  protected mapReasoningField(_chunk: Record<string, unknown>): string | undefined {
    return undefined;
  }

  /**
   * Provider-specific request parameter overrides.
   * Return an object to merge (or override) into the base request params.
   */
  protected mapRequestParams(_opts: GenerateOptions): Record<string, unknown> {
    return {};
  }

  async *generate(
    messages: ModelMessage[],
    opts: GenerateOptions = {}
  ): AsyncGenerator<StreamEvent> {
    yield* withRetryGenerator(() => this.#doGenerate(messages, opts), this.#opts.retry);
  }

  async #ensureClient(): Promise<unknown> {
    if (!this.#client) {
      const { default: OpenAI } = await import("openai");
      this.#client = new OpenAI({
        apiKey: this.#opts.apiKey,
        baseURL: (this.#opts as Record<string, unknown>)["_baseURL"] as string,
        ...(this.#opts.defaultHeaders ? { defaultHeaders: this.#opts.defaultHeaders } : {}),
      });
    }
    return this.#client;
  }

  async *#doGenerate(
    messages: ModelMessage[],
    opts: GenerateOptions = {}
  ): AsyncGenerator<StreamEvent> {
    const client = await this.#ensureClient() as InstanceType<typeof import("openai").default>;

    const openAiMessages = convertCompatMessages(messages) as Parameters<
      typeof client.chat.completions.create
    >[0]["messages"];

    const meta = getModelMeta(this.modelId);

    const params: Record<string, unknown> = {
      model: this.modelId,
      messages: openAiMessages,
      stream: true,
      stream_options: { include_usage: true },
      ...(meta.isReasoning
        ? { max_completion_tokens: opts.maxTokens ?? 16384 }
        : { max_tokens: opts.maxTokens ?? 4096 }),
    };

    if (!meta.isReasoning) {
      if (opts.temperature !== undefined) params["temperature"] = opts.temperature;
    }
    if (opts.topP !== undefined) params["top_p"] = opts.topP;
    if (opts.stopSequences && opts.stopSequences.length > 0) params["stop"] = opts.stopSequences;

    if (opts.responseFormat && this.capabilities.supportsGrammar) {
      if (opts.responseFormat.type === "json_schema") {
        params["response_format"] = {
          type: "json_schema",
          json_schema: {
            name: opts.responseFormat.name ?? "response",
            schema: opts.responseFormat.schema,
            strict: opts.responseFormat.strict ?? true,
          },
        };
      } else {
        params["response_format"] = { type: "json_object" };
      }
    }

    if (opts.tools && opts.tools.length > 0) {
      params["tools"] = opts.tools.map((t) => ({ type: "function", function: t }));
      params["tool_choice"] = "auto";
    }

    // Merge provider-specific params (subclass hook).
    const extra = this.mapRequestParams(opts);
    for (const [k, v] of Object.entries(extra)) {
      params[k] = v;
    }

    type OAIChunk = import("openai/resources/index.js").ChatCompletionChunk;
    const stream = (await client.chat.completions.create(params as unknown as Parameters<typeof client.chat.completions.create>[0])) as unknown as AsyncIterable<OAIChunk>;

    const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];

      if (choice?.delta.content) {
        yield { type: "text_delta", delta: choice.delta.content };
      }

      // Provider-specific reasoning field extraction.
      const rawChunk = chunk as unknown as Record<string, unknown>;
      const reasoningText = this.mapReasoningField(rawChunk);
      if (reasoningText) {
        yield { type: "thinking_delta", delta: reasoningText };
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
            input = { _raw: tc.arguments };
          }
          yield { type: "tool_call", toolCall: { type: "tool_use", id: tc.id, name: tc.name, input } };
        }
        yield { type: "stop", stopReason: "tool_use" };
      }

      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
        const details = (chunk.usage as unknown as Record<string, unknown>)["prompt_tokens_details"] as Record<string, unknown> | undefined;
        const cached = details?.["cached_tokens"];
        if (typeof cached === "number") cacheReadTokens = cached;
      }
    }

    if (inputTokens > 0 || outputTokens > 0) {
      const usage: import("./types.js").TokenUsage = { inputTokens, outputTokens };
      if (cacheReadTokens > 0) usage.cacheReadTokens = cacheReadTokens;
      yield { type: "usage", usage };
    }
  }
}

export interface OpenAICompatModelOptions {
  apiKey?: string;
  defaultHeaders?: Record<string, string>;
  retry?: RetryPolicy;
  /**
   * Name of the field in the raw API response chunk that carries reasoning text.
   * E.g. "reasoning_content" for DeepSeek, "thinking_content" for Kimi.
   */
  reasoningContentField?: string;
}

// ── Message converter (same as OpenAIModel but without cache annotations) ────

function convertCompatMessages(messages: ModelMessage[]): unknown[] {
  const result: unknown[] = [];
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
    const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
    const textParts: string[] = [];
    for (const block of m.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "thinking") {
        // Skip thinking blocks — compat endpoints don't accept them.
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
      result.push({ role: "assistant", content: textParts.join("\n") || null, tool_calls: toolCalls });
    } else if (textParts.length > 0 && (m.role === "user" || m.role === "assistant")) {
      result.push({ role: m.role, content: textParts.join("\n") });
    }
  }
  return result;
}
