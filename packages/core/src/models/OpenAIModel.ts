import type { RetryPolicy } from "./retry.js";
import { withRetryGenerator } from "./retry.js";
import type {
  GenerateOptions,
  Model,
  ModelCapabilities,
  ModelMessage,
  StreamEvent,
} from "./types.js";
import { getModelMeta } from "./types.js";

export interface OpenAIModelOptions {
  apiKey?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  samplingParams?: {
    temperature?: number;
    seed?: number;
    /**
     * Reasoning effort for o-series and reasoning-capable models.
     * Full range: "none" | "minimal" | "standard" | "low" | "medium" | "high" | "xhigh" | "max"
     * OpenAI wire values: none/minimal/low/medium/high/xhigh (standard→medium, max→xhigh).
     */
    reasoningEffort?: import("./types.js").ReasoningEffort;
    /**
     * Output verbosity for GPT-5+ models (A2).
     * "low" = terse, "medium" = default, "high" = detailed.
     */
    verbosity?: "low" | "medium" | "high";
  };
  retry?: RetryPolicy;
  /**
   * API surface to use.
   * "responses" (default for api.openai.com): Responses API.
   * "chat" (default when baseURL is set): Chat Completions API.
   */
  apiMode?: "responses" | "chat";
}

// ── Model enums (A4) ─────────────────────────────────────────────────────────

/** Canonical OpenAI model IDs — current and recent generations. */
export const OpenAIModels = {
  // GPT-5.x (2026)
  GPT_5: "gpt-5",
  GPT_5_1: "gpt-5.1",
  GPT_5_2: "gpt-5.2",
  GPT_5_5: "gpt-5.5",
  GPT_5_MINI: "gpt-5-mini",
  GPT_5_NANO: "gpt-5-nano",
  /** Always points to the recommended latest production model. */
  LATEST: "gpt-5.5",

  // Reasoning (o-series)
  O3: "o3",
  O4_MINI: "o4-mini",
  O3_MINI: "o3-mini",

  // Legacy (retained for compatibility)
  GPT_4O: "gpt-4o",
  GPT_4O_MINI: "gpt-4o-mini",
  GPT_4_1: "gpt-4.1",
} as const;

export type OpenAIModelId = (typeof OpenAIModels)[keyof typeof OpenAIModels] | (string & {});

/**
 * Map the unified ReasoningEffort to OpenAI's accepted wire value.
 * OpenAI supports: "none" | "low" | "medium" | "high" | "xhigh"
 * (minimal → low, standard → medium, max → xhigh)
 */
function toOpenAIEffort(effort: import("./types.js").ReasoningEffort): string {
  switch (effort) {
    case "none":
      return "none";
    case "minimal":
      return "low";
    case "standard":
      return "medium";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "xhigh";
  }
}

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
    this.#opts = typeof apiKeyOrOpts === "string" ? { apiKey: apiKeyOrOpts } : (apiKeyOrOpts ?? {});
    this.#apiMode = this.#opts.apiMode ?? (this.#opts.baseURL ? "chat" : "responses");

    const meta = getModelMeta(modelId);
    this.capabilities = {
      metered: !this.#opts.baseURL,
      localEndpoint: !!this.#opts.baseURL,
      supportsGrammar: true,
      supportsBudgetForcing: false,
      supportsReasoningEffort: meta.supportsReasoningEffort,
      supportsVerbosity: meta.supportsVerbosity,
      cacheStrategy: "auto-prefix",
      contextWindow: meta.contextWindow,
    };
  }

  get apiKey(): string | undefined {
    return this.#opts.apiKey;
  }
  get baseURL(): string | undefined {
    return this.#opts.baseURL;
  }
  get apiMode(): "responses" | "chat" {
    return this.#apiMode;
  }

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

  /** Effective reasoning effort: opts.thinking.effort > samplingParams.reasoningEffort > registry default. */
  #resolveEffort(opts: GenerateOptions): string | undefined {
    const thinkingEffort = opts.thinking?.effort;
    const samplingEffort = this.#opts.samplingParams?.reasoningEffort;
    const effort = thinkingEffort ?? samplingEffort;
    if (!effort) return undefined;
    return toOpenAIEffort(effort);
  }

  /**
   * Responses API path (default for api.openai.com).
   */
  async *#doGenerateResponses(
    messages: ModelMessage[],
    opts: GenerateOptions = {}
  ): AsyncGenerator<StreamEvent> {
    const client = (await this.#ensureClient()) as Record<string, unknown>;

    const responsesApi = client.responses as Record<string, unknown> | undefined;
    if (!responsesApi || typeof responsesApi.create !== "function") {
      yield* this.#doGenerateChat(messages, opts);
      return;
    }

    const meta = getModelMeta(this.modelId);
    const isReasoning = meta.isReasoning;
    const inputItems = convertMessagesToResponsesInput(messages);

    const params: Record<string, unknown> = {
      model: this.modelId,
      input: inputItems,
      stream: true,
      ...(isReasoning
        ? { max_output_tokens: opts.maxTokens ?? 16384 }
        : { max_output_tokens: opts.maxTokens ?? 4096 }),
    };

    if (!isReasoning) {
      const temp = opts.temperature ?? this.#opts.samplingParams?.temperature;
      if (temp !== undefined) params.temperature = temp;
    }

    // A2: reasoning effort (full range).
    const effort = this.#resolveEffort(opts);
    if (effort !== undefined) params.reasoning = { effort };

    // A2: verbosity for GPT-5+ models.
    const verbosity = opts.verbosity ?? this.#opts.samplingParams?.verbosity;
    if (verbosity !== undefined && meta.supportsVerbosity) {
      params.text = { ...((params.text as Record<string, unknown>) ?? {}), verbosity };
    }

    if (opts.topP !== undefined) params.top_p = opts.topP;
    if (opts.stopSequences && opts.stopSequences.length > 0) params.stop = opts.stopSequences;

    if (opts.responseFormat) {
      if (opts.responseFormat.type === "json_schema") {
        params.text = {
          ...((params.text as Record<string, unknown>) ?? {}),
          format: {
            type: "json_schema",
            name: opts.responseFormat.name ?? "response",
            schema: opts.responseFormat.schema,
            strict: opts.responseFormat.strict ?? true,
          },
        };
      } else {
        params.text = {
          ...((params.text as Record<string, unknown>) ?? {}),
          format: { type: "json_object" },
        };
      }
    }

    if (opts.tools && opts.tools.length > 0) {
      params.tools = opts.tools.map((t) => {
        const tool = t as Record<string, unknown>;
        // D2: custom tool grammar support.
        if (tool.customToolGrammar) {
          const { customToolGrammar, ...rest } = tool;
          return { type: "function", ...rest, grammar: customToolGrammar };
        }
        return { type: "function", ...tool };
      });
      params.tool_choice = "auto";
    }

    type ResponsesStream = AsyncIterable<Record<string, unknown>>;
    const stream = (await (responsesApi.create as (p: unknown) => Promise<unknown>)(
      params
    )) as ResponsesStream;

    const toolCallAccum = new Map<string, { id: string; name: string; arguments: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;

    for await (const event of stream) {
      const evType = event.type as string | undefined;

      if (evType === "response.output_text.delta") {
        const delta = event.delta as string | undefined;
        if (delta) yield { type: "text_delta", delta };
      }

      if (evType === "response.function_call_arguments.delta") {
        const callId = event.call_id as string | undefined;
        const delta = event.delta as string | undefined;
        if (callId && delta) {
          const existing = toolCallAccum.get(callId);
          if (existing) existing.arguments += delta;
        }
      }

      if (evType === "response.output_item.added") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          const callId = (item.call_id as string) ?? (item.id as string) ?? "";
          toolCallAccum.set(callId, {
            id: callId,
            name: (item.name as string) ?? "",
            arguments: "",
          });
        }
      }

      if (evType === "response.function_call_arguments.done") {
        const callId = event.call_id as string | undefined;
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

      if (evType === "response.completed") {
        const response = event.response as Record<string, unknown> | undefined;
        const status = response?.status as string | undefined;
        // R3: detect refusal in Responses API.
        const incomplete = response?.incomplete_details as Record<string, unknown> | undefined;
        if (incomplete?.reason === "content_filter") {
          yield { type: "text_delta", delta: "[REFUSAL]: content filtered by safety system" };
          yield { type: "stop", stopReason: "end_turn" };
          break;
        }
        if (status === "completed") {
          yield { type: "stop", stopReason: toolCallAccum.size > 0 ? "tool_use" : "end_turn" };
          const usage = response?.usage as Record<string, unknown> | undefined;
          if (usage) {
            inputTokens = (usage.input_tokens as number | undefined) ?? 0;
            outputTokens = (usage.output_tokens as number | undefined) ?? 0;
            const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
            const cached = inputDetails?.cached_tokens;
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
    const client = (await this.#ensureClient()) as InstanceType<typeof import("openai").default>;

    const openAiMessages = convertMessages(messages) as Parameters<
      typeof client.chat.completions.create
    >[0]["messages"];

    type CreateParams = Parameters<typeof client.chat.completions.create>[0];

    const meta = getModelMeta(this.modelId);
    const isReasoning = meta.isReasoning;

    const params: CreateParams = {
      model: this.modelId,
      messages: openAiMessages,
      stream: true,
      stream_options: { include_usage: true },
      ...(isReasoning
        ? { max_completion_tokens: opts.maxTokens ?? 16384 }
        : { max_tokens: opts.maxTokens ?? 4096 }),
    };
    const p = params as unknown as Record<string, unknown>;

    if (!isReasoning) {
      const temp = opts.temperature ?? this.#opts.samplingParams?.temperature;
      if (temp !== undefined) p.temperature = temp;
    }

    // A2: reasoning effort (full range via Chat API).
    const effort = this.#resolveEffort(opts);
    if (effort !== undefined) p.reasoning_effort = effort;

    if (opts.topP !== undefined) p.top_p = opts.topP;
    const seed = opts.seed ?? this.#opts.samplingParams?.seed;
    if (seed !== undefined) p.seed = seed;
    if (opts.stopSequences && opts.stopSequences.length > 0) p.stop = opts.stopSequences;

    if (opts.responseFormat && this.capabilities.supportsGrammar) {
      if (opts.responseFormat.type === "json_schema") {
        p.response_format = {
          type: "json_schema",
          json_schema: {
            name: opts.responseFormat.name ?? "response",
            schema: opts.responseFormat.schema,
            strict: opts.responseFormat.strict ?? true,
          },
        };
      } else {
        p.response_format = { type: "json_object" };
      }
    }

    if (opts.tools && opts.tools.length > 0) {
      p.tools = opts.tools.map((t) => {
        const tool = t as Record<string, unknown>;
        if (tool.customToolGrammar) {
          const { customToolGrammar, ...rest } = tool;
          return { type: "function", function: rest, grammar: customToolGrammar };
        }
        return { type: "function", function: tool };
      });
      p.tool_choice = "auto";
    }

    type OAIChunk = import("openai/resources/index.js").ChatCompletionChunk;
    const stream = (await client.chat.completions.create(
      params
    )) as unknown as AsyncIterable<OAIChunk>;

    const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];

      // R3: detect refusal — model refused to answer (strict mode safety filter).
      const refusal = (choice?.delta as unknown as Record<string, unknown>)?.refusal;
      if (typeof refusal === "string" && refusal) {
        yield { type: "text_delta", delta: `[REFUSAL]: ${refusal}` };
        yield { type: "stop", stopReason: "end_turn" };
        break;
      }

      if (choice?.delta.content) yield { type: "text_delta", delta: choice.delta.content };

      if (choice?.delta.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallAccum.has(idx)) {
            toolCallAccum.set(idx, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: "",
            });
          }
          const accum = toolCallAccum.get(idx) as { id: string; name: string; arguments: string };
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
        const details = (chunk.usage as unknown as Record<string, unknown>).prompt_tokens_details as
          | Record<string, unknown>
          | undefined;
        const cached = details?.cached_tokens;
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

/**
 * R3: Attempt to repair truncated or fence-wrapped JSON.
 * Strips markdown fences, trims whitespace, and attempts to close truncated objects.
 * Returns the repaired JSON string, or the original if repair is not possible.
 */
export function repairJson(raw: string): string {
  let s = raw.trim();
  s = s
    .replace(/^```(?:json)?\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();
  if (!s) return raw;
  try {
    JSON.parse(s);
    return s;
  } catch {
    /* continue */
  }
  const openers: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") openers.push("}");
    else if (ch === "[") openers.push("]");
    else if (ch === "}" || ch === "]") openers.pop();
  }
  let repaired = s.replace(/,\s*$/, "");
  if (inString) repaired += '"';
  while (openers.length > 0) repaired += openers.pop();
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return raw;
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

    const toolCalls: OpenAIAssistantToolMessage["tool_calls"] = [];
    const textParts: string[] = [];

    for (const block of m.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "thinking") {
        // Skip thinking blocks — OpenAI doesn't accept them in history.
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

function convertMessagesToResponsesInput(messages: ModelMessage[]): unknown[] {
  const items: unknown[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      items.push({
        type: "message",
        role: "system",
        content: typeof m.content === "string" ? m.content : "",
      });
      continue;
    }

    if (typeof m.content === "string") {
      items.push({ type: "message", role: m.role, content: m.content });
      continue;
    }

    const textParts: string[] = [];
    const toolCalls: Array<{
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }> = [];
    const toolResults: Array<{ type: "function_call_output"; call_id: string; output: string }> =
      [];

    for (const block of m.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "thinking") {
        // Skip thinking blocks for Responses API input.
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
