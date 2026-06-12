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

/**
 * Base class for OpenAI Chat Completions-compatible endpoints (B1).
 *
 * Chinese providers (DeepSeek, Kimi/Moonshot, GLM/Zhipu, Qwen/DashScope, MiniMax, Doubao/Ark)
 * expose OpenAI-compatible /chat/completions but differ in:
 *  - How they return reasoning/thinking text (non-standard fields).
 *  - How they accept thinking mode and effort parameters.
 *  - Whether multi-turn requires reasoning_content round-trip.
 *
 * Subclasses override mapReasoningField(), mapRequestParams(), mapThinkingParams(),
 * and requiresReasoningRoundTrip() to handle provider-specific differences.
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
      supportsReasoningEffort: opts.supportsReasoningEffort ?? false,
      supportsVerbosity: false,
      cacheStrategy: opts.cacheStrategy ?? "auto-prefix",
      contextWindow: meta.contextWindow,
      // First merge any extras the caller declared in opts, then merge the
      // subclass-overridden extraCapabilities() — that ordering means a
      // subclass that overrides extraCapabilities() always wins, while a
      // plain caller using GenericOpenAICompatModel still gets to set caps
      // without subclassing (A5, 2026-06).
      ...(opts.extraCapabilities ?? {}),
      ...this.extraCapabilities(),
    };
    if (opts.reasoningContentField !== undefined) {
      caps.reasoningContentField = opts.reasoningContentField;
    }
    this.capabilities = caps;
    (this.#opts as Record<string, unknown>)._baseURL = baseUrl;
  }

  /** Subclasses can override to add extra capability flags. */
  protected extraCapabilities(): Partial<ModelCapabilities> {
    return {};
  }

  /**
   * Map a raw API chunk to extract reasoning text from a provider-specific field.
   * Return undefined if this chunk contains no reasoning content.
   *
   * @param _chunk  Raw API response chunk.
   * @param _opts   GenerateOptions for the current request (for runtime thinking state).
   */
  protected mapReasoningField(
    _chunk: Record<string, unknown>,
    _opts: GenerateOptions
  ): string | undefined {
    return undefined;
  }

  /**
   * Provider-specific request parameter overrides (non-thinking).
   * Return an object to merge into the base request params.
   */
  protected mapRequestParams(_opts: GenerateOptions): Record<string, unknown> {
    return {};
  }

  /**
   * Provider-specific thinking/reasoning parameter encoding.
   *
   * Called after mapRequestParams so thinking params take precedence.
   * Return an object to merge into request params (use extra_body for non-standard keys).
   *
   * Default: returns {} (no thinking params emitted).
   */
  protected mapThinkingParams(_opts: GenerateOptions): Record<string, unknown> {
    return {};
  }

  /**
   * Whether this provider requires reasoning_content to be echoed back
   * in subsequent assistant messages for multi-turn correctness.
   *
   * @deprecated Use reasoningRoundTripPolicy() instead. Kept for backward compatibility.
   */
  protected requiresReasoningRoundTrip(): boolean {
    return this.reasoningRoundTripPolicy() !== "never";
  }

  /**
   * Conditional reasoning_content round-trip policy.
   *
   * - "never":           Thinking blocks are never echoed back (default; safe for all non-reasoning providers).
   * - "tool-turns-only": Echo reasoning_content only when the assistant message also contains tool_use.
   *                      Required by DeepSeek/Doubao/Kimi — non-tool turns must NOT include it (causes 400).
   * - "always":          Always echo reasoning_content in assistant messages (currently unused).
   */
  protected reasoningRoundTripPolicy(): "never" | "tool-turns-only" | "always" {
    return "never";
  }

  /**
   * Resolve whether thinking is enabled for this request.
   * opts.thinking.mode takes precedence over the constructor-time default.
   */
  protected thinkingEnabled(opts?: GenerateOptions, constructorDefault = true): boolean {
    const mode = opts?.thinking?.mode;
    if (mode === "off") return false;
    if (mode === "enabled" || mode === "adaptive") return true;
    return constructorDefault;
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
        baseURL: (this.#opts as Record<string, unknown>)._baseURL as string,
        ...(this.#opts.defaultHeaders ? { defaultHeaders: this.#opts.defaultHeaders } : {}),
      });
    }
    return this.#client;
  }

  async *#doGenerate(
    messages: ModelMessage[],
    opts: GenerateOptions = {}
  ): AsyncGenerator<StreamEvent> {
    const client = (await this.#ensureClient()) as InstanceType<typeof import("openai").default>;

    const openAiMessages = convertCompatMessages(
      messages,
      this.reasoningRoundTripPolicy()
    ) as Parameters<typeof client.chat.completions.create>[0]["messages"];

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
      if (opts.temperature !== undefined) params.temperature = opts.temperature;
    }
    if (opts.topP !== undefined) params.top_p = opts.topP;
    if (opts.stopSequences && opts.stopSequences.length > 0) params.stop = opts.stopSequences;

    if (opts.responseFormat && this.capabilities.supportsGrammar) {
      if (opts.responseFormat.type === "json_schema") {
        params.response_format = {
          type: "json_schema",
          json_schema: {
            name: opts.responseFormat.name ?? "response",
            schema: opts.responseFormat.schema,
            strict: opts.responseFormat.strict ?? true,
          },
        };
      } else {
        params.response_format = { type: "json_object" };
      }
    }

    if (opts.tools && opts.tools.length > 0) {
      params.tools = opts.tools.map((t) => ({ type: "function", function: t }));
      params.tool_choice = "auto";
    }

    // Non-thinking provider overrides.
    const extra = this.mapRequestParams(opts);
    for (const [k, v] of Object.entries(extra)) {
      params[k] = v;
    }

    // Thinking params — merged last so they take precedence.
    const thinkingExtra = this.mapThinkingParams(opts);
    for (const [k, v] of Object.entries(thinkingExtra)) {
      params[k] = v;
    }

    type OAIChunk = import("openai/resources/index.js").ChatCompletionChunk;
    const stream = (await client.chat.completions.create(
      params as unknown as Parameters<typeof client.chat.completions.create>[0]
    )) as unknown as AsyncIterable<OAIChunk>;

    const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];

      if (choice?.delta.content) {
        yield { type: "text_delta", delta: choice.delta.content };
      }

      const rawChunk = chunk as unknown as Record<string, unknown>;
      const reasoningText = this.mapReasoningField(rawChunk, opts);
      if (reasoningText) {
        yield { type: "thinking_delta", delta: reasoningText };
      }

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

      // Legacy OpenAI function_call delta format (single function, no index).
      // Only accumulate if tool_calls was NOT also present (avoid collision at index 0).
      const fc = (choice?.delta as unknown as Record<string, unknown>)?.function_call as
        | { name?: string; arguments?: string }
        | undefined;
      if (fc && !choice?.delta.tool_calls) {
        if (!toolCallAccum.has(0)) {
          toolCallAccum.set(0, { id: "fn-0", name: fc.name ?? "", arguments: "" });
        }
        const accum = toolCallAccum.get(0) as { id: string; name: string; arguments: string };
        if (fc.name) accum.name = fc.name;
        if (fc.arguments) accum.arguments += fc.arguments;
      }

      if (choice?.finish_reason === "stop") {
        yield { type: "stop", stopReason: "end_turn" };
      } else if (choice?.finish_reason === "length") {
        yield { type: "stop", stopReason: "max_tokens" };
      } else if (
        choice?.finish_reason === "tool_calls" ||
        choice?.finish_reason === "function_call"
      ) {
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
      } else if (choice?.finish_reason != null) {
        yield { type: "stop", stopReason: "end_turn" };
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

    if (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0) {
      const usage: import("./types.js").TokenUsage = { inputTokens, outputTokens };
      if (cacheReadTokens > 0) usage.cacheReadTokens = cacheReadTokens;
      yield { type: "usage", usage };
    }
  }
}

/**
 * A5 (S-strategic, 2026-06): canonical concrete entry point for any
 * OpenAI-compatible /chat/completions endpoint.
 *
 * The historical pattern in this repo was: every new provider got its own
 * tiny `model-*` package that subclassed `OpenAICompatModel`. The package
 * count climbed faster than the value added — 8 packages, all overriding
 * one or two of the same hooks. Mastra's 94-provider router (March 2026)
 * showed how that race ends if you commit to it: an endless adapter
 * factory that we cannot win.
 *
 * Instead, treat `GenericOpenAICompatModel` as the recommended path going
 * forward: it accepts a base URL, a model id, and an options bag, and
 * surfaces every hook that varies between providers as **runtime config**
 * rather than a subclass override. New "providers" become README recipes
 * (one for OpenRouter, one for AI Gateway, one for Ollama, one for
 * Together, one for Groq…) — see `docs/guides/openai-compat-recipes.md`.
 *
 * The existing `model-*` packages keep working exactly as before. They are
 * preserved as **presets** for users who want named imports for their
 * provider, not because the abstract hierarchy needs them.
 */
export class GenericOpenAICompatModel extends OpenAICompatModel {
  // Subclass options stash. We use a per-instance plain field rather than a
  // private name because `super()` calls some override hooks before the
  // subclass's field initialisers run; reading from a public-but-non-enumerable
  // bag set inside the constructor body is the simplest way to be order-safe.
  // Hooks that fire during super-construction (e.g. `extraCapabilities`) read
  // from the base's `opts.extraCapabilities` instead — see the base merge.
  declare readonly _generic: GenericOpenAICompatModelOptions;

  constructor(modelId: string, baseUrl: string, opts: GenericOpenAICompatModelOptions = {}) {
    super(modelId, baseUrl, opts);
    Object.defineProperty(this, "_generic", { value: opts, enumerable: false });
  }

  // Base constructor reads `opts.extraCapabilities` directly via the base
  // merge added in the same A5 commit, so we don't need to override
  // `extraCapabilities()` here. The remaining overrides only fire AFTER
  // super() finishes — by then `_generic` is set.

  protected override mapReasoningField(
    rawChunk: Record<string, unknown>,
    opts: GenerateOptions
  ): string | undefined {
    const field = this._generic?.reasoningContentField;
    if (field) {
      const choice = (rawChunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;
      const v = delta?.[field];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return super.mapReasoningField(rawChunk, opts);
  }

  protected override mapRequestParams(opts: GenerateOptions): Record<string, unknown> {
    return { ...super.mapRequestParams(opts), ...(this._generic?.extraRequestParams ?? {}) };
  }

  protected override mapThinkingParams(opts: GenerateOptions): Record<string, unknown> {
    return { ...super.mapThinkingParams(opts), ...(this._generic?.extraThinkingParams ?? {}) };
  }

  protected override reasoningRoundTripPolicy(): "never" | "tool-turns-only" | "always" {
    return this._generic?.reasoningRoundTrip ?? "never";
  }
}

export interface GenericOpenAICompatModelOptions extends OpenAICompatModelOptions {
  /** Extra params merged into every /chat/completions request. */
  extraRequestParams?: Record<string, unknown>;
  /** Extra params merged into thinking-mode requests. */
  extraThinkingParams?: Record<string, unknown>;
  /**
   * How aggressively to echo `reasoning_content` back on subsequent assistant
   * turns. Default `"never"` matches OpenAI's plain Chat Completions surface;
   * set `"tool-turns-only"` for DeepSeek-style models that need it on tool
   * round-trips.
   */
  reasoningRoundTrip?: "never" | "tool-turns-only" | "always";
  /** Extra capability flags merged into the discovered capabilities. */
  extraCapabilities?: Partial<ModelCapabilities>;
}

export interface OpenAICompatModelOptions {
  apiKey?: string;
  defaultHeaders?: Record<string, string>;
  retry?: RetryPolicy;
  /**
   * Name of the field in the raw API response chunk that carries reasoning text.
   * E.g. "reasoning_content" for DeepSeek/Doubao/Qwen/Zhipu, "thinking_content" for Kimi.
   */
  reasoningContentField?: string;
  /**
   * Override the cache strategy declared in capabilities.
   * Subclasses pass this to customize without overriding extraCapabilities().
   */
  cacheStrategy?: import("./types.js").CacheStrategy;
  /** Whether this adapter supports per-request reasoning effort control. */
  supportsReasoningEffort?: boolean;
  /**
   * Extra capability flags merged into the base capabilities at construction.
   * Set fields that the model genuinely supports (e.g. `localEndpoint: true`
   * for Ollama / LM Studio); the base sets metered/supportsGrammar to safe
   * defaults that you can flip here.
   *
   * Subclasses that override `extraCapabilities()` always win; this option
   * is for plain `GenericOpenAICompatModel` callers (A5, 2026-06).
   */
  extraCapabilities?: Partial<ModelCapabilities>;
}

// ── Message converter ─────────────────────────────────────────────────────────

/**
 * Convert agentkit ModelMessage[] to OpenAI-compatible message array.
 *
 * @param policy - Round-trip policy for reasoning_content:
 *   "never" (default): thinking blocks are discarded.
 *   "tool-turns-only": reasoning_content echoed back only when assistant message has tool_use.
 *   "always": reasoning_content always echoed back in assistant messages.
 */
export function convertCompatMessages(
  messages: ModelMessage[],
  policy: "never" | "tool-turns-only" | "always" | boolean = "never"
): unknown[] {
  // Accept legacy boolean for backward compatibility.
  const resolvedPolicy: "never" | "tool-turns-only" | "always" =
    typeof policy === "boolean" ? (policy ? "always" : "never") : policy;

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
    const toolCalls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }> = [];
    const textParts: string[] = [];
    let reasoningContent: string | undefined;
    for (const block of m.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "thinking") {
        if (resolvedPolicy !== "never" && m.role === "assistant") {
          reasoningContent = block.thinking;
        }
        // Otherwise skip — compat endpoints don't accept thinking blocks.
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
      const msg: Record<string, unknown> = {
        role: "assistant",
        content: textParts.join("\n") || null,
        tool_calls: toolCalls,
      };
      // "tool-turns-only": echo reasoning_content only when there are tool calls.
      if (
        reasoningContent !== undefined &&
        (resolvedPolicy === "always" || resolvedPolicy === "tool-turns-only")
      ) {
        msg.reasoning_content = reasoningContent;
      }
      result.push(msg);
    } else if (textParts.length > 0 && (m.role === "user" || m.role === "assistant")) {
      const msg: Record<string, unknown> = { role: m.role, content: textParts.join("\n") };
      // "tool-turns-only": do NOT echo reasoning_content on non-tool assistant turns (DeepSeek 400).
      if (reasoningContent !== undefined && resolvedPolicy === "always" && m.role === "assistant") {
        msg.reasoning_content = reasoningContent;
      }
      result.push(msg);
    }
  }
  return result;
}
