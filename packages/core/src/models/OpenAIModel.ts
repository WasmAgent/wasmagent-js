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
  samplingParams?: {
    temperature?: number;
    seed?: number;
    /** For o-series reasoning models: controls thinking depth. One of "low" | "medium" | "high". */
    reasoningEffort?: "low" | "medium" | "high";
  };
  /** Retry policy for 429/5xx/network errors. */
  retry?: RetryPolicy;
  /**
   * Which OpenAI API surface to use.
   *
   * - "responses" (default for native OpenAI): Uses the Responses API
   *   (client.responses.create). Provides better caching, native tool search,
   *   built-in compaction, and reasoning item persistence. Recommended for all
   *   new projects using api.openai.com.
   *
   * - "chat" (default when baseURL is set): Uses Chat Completions API
   *   (client.chat.completions.create). Required for Ollama, vLLM, llama.cpp,
   *   and other OpenAI-compatible local endpoints that don't implement Responses.
   *
   * The default is auto-detected: "responses" when baseURL is unset,
   * "chat" when baseURL is set (local endpoint assumed).
   */
  apiMode?: "responses" | "chat";
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

/** OpenAI model adapter — with Responses API (default) and Chat Completions fallback. */
export class OpenAIModel implements Model {
  readonly providerId: string;
  readonly capabilities: ModelCapabilities;
  readonly #opts: OpenAIModelOptions;
  readonly #apiMode: "responses" | "chat";
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
    // Auto-detect: use "chat" for local endpoints, "responses" for native OpenAI.
    this.#apiMode = this.#opts.apiMode
      ?? (this.#opts.baseURL ? "chat" : "responses");
    this.capabilities = {
      metered: !this.#opts.baseURL,
      localEndpoint: !!this.#opts.baseURL,
      supportsGrammar: true,
      supportsBudgetForcing: false,
    };
  }

  get apiKey(): string | undefined { return this.#opts.apiKey; }
  get baseURL(): string | undefined { return this.#opts.baseURL; }
  get apiMode(): "responses" | "chat" { return this.#apiMode; }

  async *generate(
    messages: ModelMessage[],
    opts: GenerateOptions = {}
  ): AsyncGenerator<StreamEvent> {
    if (this.#apiMode === "responses") {
      yield* withRetryGenerator(() => this.#doGenerateResponses(messages, opts), this.#opts.retry);
    } else {
      yield* withRetryGenerator(() => this.#doGenerateChat(messages, opts), this.#opts.retry);
    }
  }

  async #ensureClient(): Promise<unknown> {
    if (!this.#client) {
      const { default: OpenAI } = await import("openai");
      this.#client = new OpenAI({
        apiKey: this.#opts.apiKey,
        ...(this.#opts.baseURL ? { baseURL: this.#opts.baseURL } : {}),
        ...(this.#opts.defaultHeaders ? { defaultHeaders: this.#opts.defaultHeaders } : {}),
      });
    }
    return this.#client;
  }

  /**
   * Responses API path (default for api.openai.com).
   *
   * Uses client.responses.create with stream:true. Advantages over Chat Completions:
   * - Better prefix caching (40–80% higher cache hit rate in practice).
   * - previous_response_id for stateful sessions and built-in compaction.
   * - Native tool search and built-in tools (web, code, file, remote MCP).
   * - Reasoning item persistence for o-series models.
   */
  async *#doGenerateResponses(
    messages: ModelMessage[],
    opts: GenerateOptions = {}
  ): AsyncGenerator<StreamEvent> {
    const client = await this.#ensureClient() as Record<string, unknown>;

    const responsesApi = client["responses"] as Record<string, unknown> | undefined;
    if (!responsesApi || typeof responsesApi["create"] !== "function") {
      // SDK version doesn't support Responses API — fall back to Chat Completions.
      yield* this.#doGenerateChat(messages, opts);
      return;
    }

    const isReasoningModel = /^o\d/.test(this.modelId);
    const inputItems = convertMessagesToResponsesInput(messages);

    const params: Record<string, unknown> = {
      model: this.modelId,
      input: inputItems,
      stream: true,
      ...(isReasoningModel
        ? { max_output_tokens: opts.maxTokens ?? 16384 }
        : { max_output_tokens: opts.maxTokens ?? 4096 }),
    };

    if (!isReasoningModel) {
      const temp = opts.temperature ?? this.#opts.samplingParams?.temperature;
      if (temp !== undefined) params["temperature"] = temp;
    }
    if (isReasoningModel && this.#opts.samplingParams?.reasoningEffort) {
      params["reasoning"] = { effort: this.#opts.samplingParams.reasoningEffort };
    }
    if (opts.topP !== undefined) params["top_p"] = opts.topP;
    if (opts.stopSequences && opts.stopSequences.length > 0) params["stop"] = opts.stopSequences;
    if (opts.responseFormat) {
      if (opts.responseFormat.type === "json_schema") {
        params["text"] = {
          format: {
            type: "json_schema",
            name: opts.responseFormat.name ?? "response",
            schema: opts.responseFormat.schema,
            strict: opts.responseFormat.strict ?? true,
          },
        };
      } else {
        params["text"] = { format: { type: "json_object" } };
      }
    }
    if (opts.tools && opts.tools.length > 0) {
      params["tools"] = opts.tools.map((t) => ({ type: "function", ...t }));
      params["tool_choice"] = "auto";
    }

    type ResponsesStream = AsyncIterable<Record<string, unknown>>;
    const stream = (await (responsesApi["create"] as (p: unknown) => Promise<unknown>)(params)) as ResponsesStream;

    const toolCallAccum = new Map<string, { id: string; name: string; arguments: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;

    for await (const event of stream) {
      const evType = event["type"] as string | undefined;

      // Text delta.
      if (evType === "response.output_text.delta") {
        const delta = event["delta"] as string | undefined;
        if (delta) yield { type: "text_delta", delta };
      }

      // Tool call argument delta.
      if (evType === "response.function_call_arguments.delta") {
        const callId = event["call_id"] as string | undefined;
        const delta = event["delta"] as string | undefined;
        if (callId && delta) {
          const existing = toolCallAccum.get(callId);
          if (existing) existing.arguments += delta;
        }
      }

      // Tool call start — captures id and name.
      if (evType === "response.output_item.added") {
        const item = event["item"] as Record<string, unknown> | undefined;
        if (item?.["type"] === "function_call") {
          const callId = item["call_id"] as string ?? item["id"] as string ?? "";
          toolCallAccum.set(callId, {
            id: callId,
            name: item["name"] as string ?? "",
            arguments: "",
          });
        }
      }

      // Tool call done — emit tool_call event.
      if (evType === "response.function_call_arguments.done") {
        const callId = event["call_id"] as string | undefined;
        if (callId) {
          const tc = toolCallAccum.get(callId);
          if (tc) {
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
        }
      }

      // Completion done.
      if (evType === "response.completed") {
        const response = event["response"] as Record<string, unknown> | undefined;
        const status = response?.["status"] as string | undefined;
        if (status === "completed") {
          if (toolCallAccum.size > 0) {
            yield { type: "stop", stopReason: "tool_use" };
          } else {
            yield { type: "stop", stopReason: "end_turn" };
          }
          // Usage from completed event.
          const usage = response?.["usage"] as Record<string, unknown> | undefined;
          if (usage) {
            inputTokens = (usage["input_tokens"] as number | undefined) ?? 0;
            outputTokens = (usage["output_tokens"] as number | undefined) ?? 0;
            const inputDetails = usage["input_tokens_details"] as Record<string, unknown> | undefined;
            const cached = inputDetails?.["cached_tokens"];
            if (typeof cached === "number") cacheReadTokens = cached;
          }
        } else if (status === "incomplete") {
          yield { type: "stop", stopReason: "max_tokens" };
        }
      }
    }

    if (inputTokens > 0 || outputTokens > 0) {
      const usage: import("./types.js").TokenUsage = { inputTokens, outputTokens };
      if (cacheReadTokens > 0) usage.cacheReadTokens = cacheReadTokens;
      yield { type: "usage", usage };
    }
  }

  /** Chat Completions API path — used for local endpoints (Ollama, vLLM, etc.). */
  async *#doGenerateChat(
    messages: ModelMessage[],
    opts: GenerateOptions = {}
  ): AsyncGenerator<StreamEvent> {
    const client = await this.#ensureClient() as InstanceType<typeof import("openai").default>;

    const openAiMessages = convertMessages(messages) as Parameters<
      typeof client.chat.completions.create
    >[0]["messages"];

    type CreateParams = Parameters<typeof client.chat.completions.create>[0];

    const isReasoningModel = /^o\d/.test(this.modelId);

    const params: CreateParams = {
      model: this.modelId,
      messages: openAiMessages,
      stream: true,
      stream_options: { include_usage: true },
      ...(isReasoningModel
        ? { max_completion_tokens: opts.maxTokens ?? 16384 }
        : { max_tokens: opts.maxTokens ?? 4096 }),
    };
    const p = params as unknown as Record<string, unknown>;
    if (!isReasoningModel) {
      if (opts.temperature !== undefined) {
        p["temperature"] = opts.temperature;
      } else if (this.#opts.samplingParams?.temperature !== undefined) {
        p["temperature"] = this.#opts.samplingParams.temperature;
      }
    }
    if (isReasoningModel && this.#opts.samplingParams?.reasoningEffort) {
      p["reasoning_effort"] = this.#opts.samplingParams.reasoningEffort;
    }
    if (opts.topP !== undefined) p["top_p"] = opts.topP;
    if (opts.seed !== undefined) {
      p["seed"] = opts.seed;
    } else if (this.#opts.samplingParams?.seed !== undefined) {
      p["seed"] = this.#opts.samplingParams.seed;
    }
    if (opts.stopSequences && opts.stopSequences.length > 0) p["stop"] = opts.stopSequences;
    if (opts.responseFormat && this.capabilities.supportsGrammar) {
      if (opts.responseFormat.type === "json_schema") {
        p["response_format"] = {
          type: "json_schema",
          json_schema: {
            name: opts.responseFormat.name ?? "response",
            schema: opts.responseFormat.schema,
            strict: opts.responseFormat.strict ?? true,
          },
        };
      } else {
        p["response_format"] = { type: "json_object" };
      }
    }
    if (opts.tools && opts.tools.length > 0) {
      p["tools"] = opts.tools.map((t) => ({ type: "function", function: t }));
      p["tool_choice"] = "auto";
    }

    type OAIChunk = import("openai/resources/index.js").ChatCompletionChunk;
    const stream = (await client.chat.completions.create(params)) as unknown as AsyncIterable<OAIChunk>;

    const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];

      if (choice?.delta.content) yield { type: "text_delta", delta: choice.delta.content };

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
            console.warn(`[OpenAIModel] Failed to parse tool-call arguments for "${tc.name}". Raw: ${tc.arguments}`);
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

// ── Message converters ────────────────────────────────────────────────────────

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
      result.push({ role: "assistant", content: textParts.join("\n") || null, tool_calls: toolCalls });
    } else if (textParts.length > 0 && (m.role === "user" || m.role === "assistant")) {
      result.push({ role: m.role, content: textParts.join("\n") });
    }
  }

  return result;
}

/**
 * Convert ModelMessage[] to Responses API input format.
 * Responses API uses a flat item list with typed items rather than a message array.
 */
function convertMessagesToResponsesInput(messages: ModelMessage[]): unknown[] {
  const items: unknown[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      // System messages become system instructions in the top-level params,
      // but the Responses API also accepts them inline as "system" role messages.
      items.push({ type: "message", role: "system", content: typeof m.content === "string" ? m.content : "" });
      continue;
    }

    if (typeof m.content === "string") {
      items.push({ type: "message", role: m.role, content: m.content });
      continue;
    }

    const textParts: string[] = [];
    const toolCalls: Array<{ type: "function_call"; call_id: string; name: string; arguments: string }> = [];
    const toolResults: Array<{ type: "function_call_output"; call_id: string; output: string }> = [];

    for (const block of m.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use" && m.role === "assistant") {
        toolCalls.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === "tool_result") {
        toolResults.push({
          type: "function_call_output",
          call_id: block.toolUseId,
          output: block.content,
        });
      }
    }

    if (textParts.length > 0) {
      items.push({ type: "message", role: m.role, content: textParts.join("\n") });
    }
    for (const tc of toolCalls) items.push(tc);
    for (const tr of toolResults) items.push(tr);
  }

  return items;
}
