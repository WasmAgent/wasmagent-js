import type { GenerateOptions, ModelCapabilities, StreamEvent } from "@wasmagent/core/models";
import { OpenAICompatModel, type OpenAICompatModelOptions } from "@wasmagent/core/models";

/** International endpoint (default). */
export const MINIMAX_BASE_URL = "https://api.minimax.io/v1";
/** Mainland China endpoint. */
export const MINIMAX_CN_BASE_URL = "https://api.minimaxi.com/v1";

/** Canonical MiniMax model IDs. */
export const MiniMaxModels = {
  TEXT_01: "minimax-text-01",
  M2: "MiniMax-M2",
  M2_5: "MiniMax-M2.5",
  M2_7: "MiniMax-M2.7",
  M2_7_HIGHSPEED: "MiniMax-M2.7-highspeed",
  M3: "MiniMax-M3",
  /** Always points to the latest recommended model. */
  LATEST: "MiniMax-M3",
} as const;

export type MiniMaxModelId = (typeof MiniMaxModels)[keyof typeof MiniMaxModels] | (string & {});

export interface MiniMaxModelOptions extends OpenAICompatModelOptions {
  /**
   * Enable reasoning_split mode for M2+ models.
   * When true, reasoning content arrives in `delta.reasoning_details` (separate from content).
   * When false, reasoning is embedded in `delta.content` as `<think>...</think>` tags.
   * Default: true for M2+ models.
   */
  reasoningSplit?: boolean;
  /**
   * API region. "cn" uses api.minimaxi.com for mainland China.
   * Default: "intl" (api.minimax.io).
   */
  region?: "intl" | "cn";
}

/**
 * MiniMax model adapter.
 *
 * MiniMax M2/M2.5/M2.7/M3 are reasoning models with two thinking modes:
 * 1. `reasoning_split:true` (default): thinking arrives in `delta.reasoning_details` array.
 * 2. `reasoning_split:false`: thinking embedded in `delta.content` as `<think>...</think>` tags.
 *
 * Base URL: api.minimax.io/v1 (international) or api.minimaxi.com/v1 (mainland China).
 * Old api.minimax.chat/v1 is no longer active.
 */
export class MiniMaxModel extends OpenAICompatModel {
  readonly #reasoningSplit: boolean;

  constructor(modelId: MiniMaxModelId, apiKeyOrOpts?: string | MiniMaxModelOptions) {
    const opts: MiniMaxModelOptions =
      typeof apiKeyOrOpts === "string" ? { apiKey: apiKeyOrOpts } : (apiKeyOrOpts ?? {});
    const isReasoningModel = /^MiniMax-M[0-9]/.test(modelId);
    const baseUrl = opts.region === "cn" ? MINIMAX_CN_BASE_URL : MINIMAX_BASE_URL;
    const superOpts: MiniMaxModelOptions & { reasoningContentField?: string } = {
      ...opts,
    };
    if (isReasoningModel) {
      superOpts.reasoningContentField = "reasoning_details";
    }
    super(modelId, baseUrl, superOpts);
    this.#reasoningSplit = opts.reasoningSplit ?? isReasoningModel;
  }

  protected override extraCapabilities(): Partial<ModelCapabilities> {
    const isReasoningModel = /^MiniMax-M[0-9]/.test(this.modelId);
    return isReasoningModel ? { reasoningContentField: "reasoning_details" } : {};
  }

  /**
   * Extract reasoning text from reasoning_details array (reasoning_split=true).
   * When reasoning_split=false, reasoning is embedded in content — handled in generate override.
   */
  protected override mapReasoningField(
    chunk: Record<string, unknown>,
    _opts: GenerateOptions
  ): string | undefined {
    if (!this.#reasoningSplit) return undefined;
    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
    const details = delta?.reasoning_details;
    if (!Array.isArray(details)) return undefined;
    const parts = details
      .map((d: unknown) =>
        d && typeof d === "object" && "text" in d ? (d as Record<string, unknown>).text : null
      )
      .filter((t): t is string => typeof t === "string");
    return parts.length > 0 ? parts.join("") : undefined;
  }

  protected override mapRequestParams(_opts: GenerateOptions): Record<string, unknown> {
    if (this.#reasoningSplit) {
      return { reasoning_split: true };
    }
    return {};
  }

  /**
   * Override generate to handle `<think>...</think>` tag parsing when reasoning_split=false.
   * The base class handles the reasoning_split=true path via mapReasoningField.
   */
  override async *generate(
    messages: Parameters<OpenAICompatModel["generate"]>[0],
    opts: GenerateOptions = {}
  ): AsyncGenerator<StreamEvent> {
    if (this.#reasoningSplit) {
      // reasoning_split=true: base class handles reasoning via mapReasoningField.
      yield* super.generate(messages, opts);
      return;
    }

    // reasoning_split=false: intercept text_delta events and parse <think> tags.
    // State is local so concurrent generate() calls on the same instance are safe.
    const state = { inThinkTag: false, buffer: "" };

    for await (const event of super.generate(messages, opts)) {
      if (event.type === "text_delta" && typeof event.delta === "string") {
        yield* this.#parseThinkTags(event.delta, state);
      } else {
        yield event;
      }
    }

    // Flush any remaining buffered content.
    if (state.buffer.length > 0) {
      yield { type: state.inThinkTag ? "thinking_delta" : "text_delta", delta: state.buffer };
    }
  }

  /** Parse a text chunk, splitting on `<think>` / `</think>` across chunk boundaries. */
  *#parseThinkTags(
    text: string,
    state: { inThinkTag: boolean; buffer: string }
  ): Generator<StreamEvent> {
    // Prepend any buffered partial tag from the previous chunk.
    const input = state.buffer + text;
    state.buffer = "";

    let remaining = input;

    while (remaining.length > 0) {
      if (state.inThinkTag) {
        const closeIdx = remaining.indexOf("</think>");
        if (closeIdx === -1) {
          // No closing tag — check if end of string is a partial closing tag.
          const partialLen = this.#partialTagLength(remaining, "</think>");
          if (partialLen > 0) {
            // Emit confirmed thinking content, buffer the potential partial tag.
            yield {
              type: "thinking_delta",
              delta: remaining.slice(0, remaining.length - partialLen),
            };
            state.buffer = remaining.slice(remaining.length - partialLen);
            return;
          }
          yield { type: "thinking_delta", delta: remaining };
          return;
        }
        // Found closing tag — emit everything before it as thinking.
        if (closeIdx > 0) yield { type: "thinking_delta", delta: remaining.slice(0, closeIdx) };
        state.inThinkTag = false;
        remaining = remaining.slice(closeIdx + "</think>".length);
      } else {
        const openIdx = remaining.indexOf("<think>");
        if (openIdx === -1) {
          // No opening tag — check if end of string is a partial opening tag.
          const partialLen = this.#partialTagLength(remaining, "<think>");
          if (partialLen > 0) {
            if (remaining.length - partialLen > 0) {
              yield {
                type: "text_delta",
                delta: remaining.slice(0, remaining.length - partialLen),
              };
            }
            state.buffer = remaining.slice(remaining.length - partialLen);
            return;
          }
          yield { type: "text_delta", delta: remaining };
          return;
        }
        // Found opening tag — emit text before it.
        if (openIdx > 0) yield { type: "text_delta", delta: remaining.slice(0, openIdx) };
        state.inThinkTag = true;
        remaining = remaining.slice(openIdx + "<think>".length);
      }
    }
  }

  /**
   * Returns the length of the longest suffix of `text` that is a prefix of `tag`.
   * Used to detect partial tags split across chunk boundaries.
   */
  #partialTagLength(text: string, tag: string): number {
    for (let len = Math.min(tag.length - 1, text.length); len > 0; len--) {
      if (text.endsWith(tag.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }
}
