import type {
  GenerateOptions,
  Model,
  ModelCapabilities,
  ModelMessage,
  StreamEvent,
  TokenUsage,
} from "./types.js";
import { CACHE_MIN_TOKENS, estimateTokens, getModelMeta } from "./types.js";
import type { RetryPolicy } from "./retry.js";
import { withRetryGenerator } from "./retry.js";

const ANTHROPIC_MAX_CACHE_BREAKPOINTS = 4;

/**
 * Trim cache breakpoints so the total never exceeds ANTHROPIC_MAX_CACHE_BREAKPOINTS.
 * System (1) + tools (1) = 2 slots consumed; at most 2 remain for history.
 */
function trimCacheBreakpoints(messages: AnthropicMessage[]): void {
  type Ref = { block: AnthropicTextBlock };
  const refs: Ref[] = [];
  for (const msg of messages) {
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && (block as AnthropicTextBlock).cache_control) {
          refs.push({ block: block as AnthropicTextBlock });
        }
      }
    }
  }
  const historyBudget = ANTHROPIC_MAX_CACHE_BREAKPOINTS - 2;
  if (refs.length <= historyBudget) return;
  for (const { block } of refs.slice(0, refs.length - historyBudget)) {
    delete block.cache_control;
  }
}

export { CACHE_MIN_TOKENS };

/** Canonical Anthropic model IDs. */
export const AnthropicModels = {
  OPUS_LATEST:   "claude-opus-4-8",
  SONNET_LATEST: "claude-sonnet-4-6",
  HAIKU_LATEST:  "claude-haiku-4-5-20251001",
} as const;

export type AnthropicModelId = typeof AnthropicModels[keyof typeof AnthropicModels] | (string & {});

/** Anthropic model IDs that use legacy budget_tokens instead of adaptive thinking. */
const LEGACY_BUDGET_TOKENS_MODELS = new Set([
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-sonnet-4-5",
]);

/** Minimum Anthropic model version for adaptive thinking (≥4.7). */
function isAdaptiveThinkingModel(modelId: string): boolean {
  // claude-*-4-7 and later support adaptive thinking.
  const match = modelId.match(/claude-\w+-4-(\d+)/);
  if (match) return parseInt(match[1]!, 10) >= 7;
  // claude-*-4-8 special form
  const match2 = modelId.match(/claude-\w+-4-(\d+)/);
  if (match2) return parseInt(match2[1]!, 10) >= 7;
  return false;
}

export interface AnthropicModelOptions {
  apiKey?: string;
  baseURL?: string;
  retry?: RetryPolicy;
  /**
   * Use Anthropic's server-side context management (experimental).
   * When true: attaches the context-management beta and skips local
   * MessageAssembler.editToolResults() — the server manages context trimming.
   * Mutually exclusive with local context editing.
   */
  serverSideContextManagement?: boolean;
  /**
   * Use Anthropic's server-side memory tool (experimental).
   * When true: attaches the memory-tool beta and skips local memory tool injection.
   * Mutually exclusive with createMemoryTool() usage.
   */
  serverSideMemory?: boolean;
}

export class AnthropicModel implements Model {
  readonly providerId: string;
  readonly capabilities: ModelCapabilities;
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
    const meta = getModelMeta(modelId);
    this.capabilities = {
      metered: true,
      supportsGrammar: true,
      supportsBudgetForcing: true,
      supportsReasoningEffort: meta.supportsReasoningEffort,
      supportsVerbosity: false,
      cacheStrategy: "anthropic-explicit",
      contextWindow: meta.contextWindow,
    };
  }

  get apiKey(): string | undefined {
    return this.#opts.apiKey;
  }

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
    const estimatedSystemTokens = estimateTokens(systemMessage);
    const shouldCache = estimatedSystemTokens >= this.cacheMinTokens;

    const anthropicMessages = convertMessages(messages, shouldCache, this.cacheMinTokens);
    trimCacheBreakpoints(anthropicMessages as AnthropicMessage[]);
    const trimmedMessages = anthropicMessages as Parameters<
      typeof client.messages.stream
    >[0]["messages"];

    const has1hTtl = messages.some((m) => m.cacheBreakpoint?.ttl === "1h");

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

    const betas: string[] = [];
    if (has1hTtl) betas.push("extended-cache-ttl-2025-04-11");

    // A1: Adaptive thinking / extended thinking support.
    if (opts.thinking && opts.thinking.mode !== "off") {
      const thinkingParam = this.#buildThinkingParam(opts);
      if (thinkingParam) {
        (streamParams as unknown as Record<string, unknown>)["thinking"] = thinkingParam;
        // Adaptive thinking requires interleaved-thinking beta for ≤4.6 models.
        if (!isAdaptiveThinkingModel(this.modelId)) {
          betas.push("interleaved-thinking-2025-05-14");
        }
        // When thinking is enabled, temperature must be 1 (Anthropic requirement).
        if (opts.temperature === undefined || opts.temperature !== 1) {
          (streamParams as unknown as Record<string, unknown>)["temperature"] = 1;
        }
      }
    }

    // A3: Structured output via forced single-tool invocation.
    let structuredOutputToolName: string | undefined;
    if (opts.responseFormat?.type === "json_schema") {
      structuredOutputToolName = opts.responseFormat.name ?? "structured_output";
      const syntheticTool = {
        name: structuredOutputToolName,
        description: "Return the structured response conforming to the given schema.",
        input_schema: opts.responseFormat.schema,
      };
      const existingTools = ((streamParams as unknown as Record<string, unknown>)["tools"] as unknown[]) ?? [];
      (streamParams as unknown as Record<string, unknown>)["tools"] = [...existingTools, syntheticTool];
      (streamParams as unknown as Record<string, unknown>)["tool_choice"] = {
        type: "tool",
        name: structuredOutputToolName,
      };
    } else if (opts.responseFormat?.type === "json_object") {
      // Fallback: best-effort via system instruction (no native json_object mode).
      // The structured output tool approach above is preferred.
    }

    if (opts.tools && opts.tools.length > 0) {
      const allTools = opts.tools as Array<Record<string, unknown>>;
      const hasDeferredTools = allTools.some((t) => t["deferLoading"] === true);
      if (hasDeferredTools) betas.push("advanced-tool-use-2025-11-20");
      const hasPtcTools = allTools.some((t) => Array.isArray(t["allowed_callers"]));
      if (hasPtcTools) betas.push("code_execution_20260120");

      const wireTools = allTools
        .filter((t) => !t["deferLoading"])
        .map((t, i, arr) => {
          const { deferLoading: _dl, ...rest } = t;
          const wire: Record<string, unknown> = { ...rest };
          if (i === arr.length - 1) wire["cache_control"] = { type: "ephemeral" };
          return wire;
        });

      if (wireTools.length > 0) {
        // Merge with any synthetic structured-output tool already added.
        const existing = ((streamParams as unknown as Record<string, unknown>)["tools"] as unknown[]) ?? [];
        const syntheticCount = structuredOutputToolName ? 1 : 0;
        const baseTools = (existing as unknown[]).slice(0, syntheticCount);
        (streamParams as unknown as Record<string, unknown>)["tools"] = [...baseTools, ...wireTools];
      }
    }

    // D1: server-side context management / memory betas.
    if (this.#opts.serverSideContextManagement) betas.push("context-management-2025-11");
    if (this.#opts.serverSideMemory) betas.push("memory-tool-2025-11");

    if (betas.length > 0) {
      (streamParams as unknown as Record<string, unknown>)["betas"] = betas;
    }

    const stream = client.messages.stream(streamParams);

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield { type: "text_delta", delta: event.delta.text };
      } else if (
        event.type === "content_block_delta" &&
        (event.delta as unknown as Record<string, unknown>)["type"] === "thinking_delta"
      ) {
        const thinkingDelta = (event.delta as unknown as Record<string, unknown>)["thinking"] as string | undefined;
        if (thinkingDelta) yield { type: "thinking_delta", delta: thinkingDelta };
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

    // Emit tool_use blocks — but skip the synthetic structured-output tool.
    for (const block of finalMessage.content) {
      if (block.type === "tool_use") {
        if (block.name === structuredOutputToolName) {
          // Emit the structured result as text_delta so callers see it uniformly.
          yield {
            type: "text_delta",
            delta: JSON.stringify(block.input),
          };
        } else {
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
    }

    if (finalMessage.usage) {
      const u = finalMessage.usage;
      const usage: TokenUsage = {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
      };
      const uAny = u as unknown as Record<string, unknown>;
      const cacheRead = uAny["cache_read_input_tokens"];
      const cacheWrite = uAny["cache_creation_input_tokens"];
      if (typeof cacheRead === "number") usage.cacheReadTokens = cacheRead;
      if (typeof cacheWrite === "number") usage.cacheWriteTokens = cacheWrite;
      const cache5mRead = uAny["ephemeral_5m_input_tokens"];
      const cache1hRead = uAny["ephemeral_1h_input_tokens"];
      const cacheCreation = uAny["cache_creation"] as Record<string, unknown> | undefined;
      if (typeof cache5mRead === "number") usage.cacheReadTokens = cache5mRead;
      if (typeof cache1hRead === "number") usage.cacheReadTokens1h = cache1hRead;
      if (typeof cacheCreation?.["ephemeral_1h_input_tokens"] === "number") {
        usage.cacheWriteTokens1h = cacheCreation["ephemeral_1h_input_tokens"] as number;
      }
      // Thinking token usage.
      const thinkTokens = uAny["thinking_tokens"];
      if (typeof thinkTokens === "number") usage.thinkingTokens = thinkTokens;
      yield { type: "usage", usage };
    }
  }

  /**
   * Build the `thinking` parameter for the Anthropic API.
   * Handles the adaptive (≥4.7) vs legacy budget_tokens (≤4.6) split.
   */
  #buildThinkingParam(opts: GenerateOptions): Record<string, unknown> | null {
    const t = opts.thinking;
    if (!t || t.mode === "off") return null;

    if (t.mode === "enabled") {
      // Legacy budget_tokens mode — only valid on ≤4.6 models.
      if (isAdaptiveThinkingModel(this.modelId)) {
        throw new Error(
          `[AnthropicModel] thinking.mode="enabled" with budgetTokens is not supported on ` +
          `${this.modelId} (≥4.7). Use thinking.mode="adaptive" with an effort level instead. ` +
          `The budget_tokens parameter was deprecated and returns HTTP 400 on Anthropic ≥4.7.`
        );
      }
      return { type: "enabled", budget_tokens: t.budgetTokens ?? 8000 };
    }

    // mode === "adaptive"
    const effort = t.effort ?? getModelMeta(this.modelId).defaultEffort ?? "standard";
    return { type: "adaptive", effort };
  }
}

// ── Message converters ────────────────────────────────────────────────────────

function extractSystemMessage(messages: ModelMessage[]): string {
  const sys = messages.find((m) => m.role === "system");
  if (!sys) return "";
  return typeof sys.content === "string" ? sys.content : "";
}

type AnthropicCacheControl = { type: "ephemeral"; ttl?: "5m" | "1h" };

interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
}

interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
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
  is_error?: true;
}

type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

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
        const chunkTokens = estimateTokens(m.content);
        if (m.cacheBreakpoint && shouldCache && chunkTokens >= cacheMinTokens) {
          const cc: AnthropicCacheControl = { type: "ephemeral" };
          if (m.cacheBreakpoint.ttl) cc.ttl = m.cacheBreakpoint.ttl;
          return {
            role,
            content: [{ type: "text" as const, text: m.content, cache_control: cc }],
          };
        }
        return { role, content: m.content };
      }

      const blocks: AnthropicBlock[] = m.content
        .map((b): AnthropicBlock | null => {
          if (b.type === "text") return { type: "text", text: b.text };
          if (b.type === "thinking") {
            // Preserve thinking blocks in multi-turn to avoid cache invalidation (A1).
            return { type: "thinking", thinking: b.thinking, ...(b.signature ? { signature: b.signature } : {}) };
          }
          if (b.type === "tool_use") {
            return { type: "tool_use", id: b.id, name: b.name, input: b.input };
          }
          if (b.type === "tool_result") {
            const block: AnthropicToolResultBlock = {
              type: "tool_result",
              tool_use_id: b.toolUseId,
              content: b.content || "Tool execution failed with no output.",
            };
            if (b.isError) block.is_error = true;
            return block;
          }
          return null;
        })
        .filter((b): b is AnthropicBlock => b !== null);

      if (m.cacheBreakpoint && shouldCache && blocks.length > 0) {
        const textContent = blocks
          .filter((b): b is AnthropicTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (estimateTokens(textContent) >= cacheMinTokens) {
          const lastText = [...blocks].reverse().find((b): b is AnthropicTextBlock => b.type === "text");
          if (lastText) {
            const cc: AnthropicCacheControl = { type: "ephemeral" };
            if (m.cacheBreakpoint.ttl) cc.ttl = m.cacheBreakpoint.ttl;
            lastText.cache_control = cc;
          }
        }
      }

      return { role, content: blocks.length > 0 ? blocks : "" };
    });
}
