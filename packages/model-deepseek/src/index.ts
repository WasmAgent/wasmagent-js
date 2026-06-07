import { OpenAICompatModel, type OpenAICompatModelOptions } from "@agentkit-js/core/models";
import type { GenerateOptions, ModelCapabilities } from "@agentkit-js/core/models";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

/** Canonical DeepSeek model IDs. */
export const DeepSeekModels = {
  CHAT:      "deepseek-chat",
  REASONER:  "deepseek-reasoner",
  V4_PRO:    "deepseek-v4-pro",
  /** Always points to the latest recommended model. */
  LATEST:    "deepseek-v4-pro",
} as const;

export type DeepSeekModelId = typeof DeepSeekModels[keyof typeof DeepSeekModels] | (string & {});

export interface DeepSeekModelOptions extends OpenAICompatModelOptions {
  /**
   * Whether to include the think-step in the response for reasoner models.
   * Default: true (thinking is shown as thinking_delta stream events).
   */
  preserveThinking?: boolean;
}

/**
 * DeepSeek model adapter.
 *
 * DeepSeek-Reasoner returns reasoning text in a separate `reasoning_content`
 * field alongside the main `content`. This adapter extracts it and emits
 * it as `thinking_delta` stream events so the rest of the framework treats
 * it uniformly alongside Anthropic thinking.
 */
export class DeepSeekModel extends OpenAICompatModel {
  readonly #preserveThinking: boolean;

  constructor(
    modelId: DeepSeekModelId,
    apiKeyOrOpts?: string | DeepSeekModelOptions
  ) {
    const opts: DeepSeekModelOptions = typeof apiKeyOrOpts === "string"
      ? { apiKey: apiKeyOrOpts }
      : (apiKeyOrOpts ?? {});
    super(modelId, DEEPSEEK_BASE_URL, {
      ...opts,
      reasoningContentField: "reasoning_content",
    });
    this.#preserveThinking = opts.preserveThinking ?? true;
  }

  protected override extraCapabilities(): Partial<ModelCapabilities> {
    return { reasoningContentField: "reasoning_content" };
  }

  /**
   * Extract DeepSeek's reasoning_content from the delta.
   * The field appears at: chunk.choices[0].delta.reasoning_content
   */
  protected override mapReasoningField(chunk: Record<string, unknown>): string | undefined {
    if (!this.#preserveThinking) return undefined;
    const choices = chunk["choices"] as Array<Record<string, unknown>> | undefined;
    const delta = choices?.[0]?.["delta"] as Record<string, unknown> | undefined;
    const reasoning = delta?.["reasoning_content"];
    if (typeof reasoning === "string" && reasoning.length > 0) return reasoning;
    return undefined;
  }

  protected override mapRequestParams(_opts: GenerateOptions): Record<string, unknown> {
    return {};
  }
}
