import type { GenerateOptions, ModelCapabilities } from "@wasmagent/core/models";
import { OpenAICompatModel, type OpenAICompatModelOptions } from "@wasmagent/core/models";

export const QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const QWEN_INTL_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

/** Canonical Qwen (Alibaba) model IDs. */
export const QwenModels = {
  QWEN3_MAX: "qwen3-max",
  QWEN3_PLUS: "qwen3-plus",
  QWEN3_TURBO: "qwen3-turbo",
  QWEN2_5_72B: "qwen2.5-72b-instruct",
  /** Always points to the latest recommended model. */
  LATEST: "qwen3-max",
} as const;

export type QwenModelId = (typeof QwenModels)[keyof typeof QwenModels] | (string & {});

export interface QwenModelOptions extends OpenAICompatModelOptions {
  /** Enable thinking mode for Qwen3 models. Default: true for qwen3-* models. */
  enableThinking?: boolean;
  /**
   * API region. "intl" uses dashscope-intl.aliyuncs.com for international access.
   * Default: "cn" (mainland China endpoint).
   */
  region?: "cn" | "intl";
}

/**
 * Qwen (Alibaba DashScope) model adapter.
 *
 * Qwen3 supports thinking via `enable_thinking` parameter:
 * - Must be explicitly set to false to disable (default on = thinking active).
 * - `thinking_budget` controls token budget; maps from effort or explicit budgetTokens.
 * - `enable_thinking` only works in streaming mode (base class always streams).
 * - Runtime opts.thinking.mode overrides the constructor-time default.
 *
 * Note: use region:"intl" for international endpoints.
 */
export class QwenModel extends OpenAICompatModel {
  readonly #defaultEnableThinking: boolean;
  readonly #isThinkingModel: boolean;

  /** Effort → thinking_budget token mapping. */
  static readonly EFFORT_BUDGET: Record<string, number> = {
    minimal: 2_000,
    low: 4_000,
    standard: 8_000,
    medium: 8_000,
    high: 16_000,
    xhigh: 24_000,
    max: 38_000,
  };

  constructor(modelId: QwenModelId, apiKeyOrOpts?: string | QwenModelOptions) {
    const opts: QwenModelOptions =
      typeof apiKeyOrOpts === "string" ? { apiKey: apiKeyOrOpts } : (apiKeyOrOpts ?? {});
    const isThinkingModel = modelId.startsWith("qwen3");
    const baseUrl = opts.region === "intl" ? QWEN_INTL_BASE_URL : QWEN_BASE_URL;
    super(modelId, baseUrl, {
      ...opts,
      reasoningContentField: "reasoning_content",
    });
    this.#defaultEnableThinking = opts.enableThinking ?? isThinkingModel;
    this.#isThinkingModel = isThinkingModel;
  }

  protected override extraCapabilities(): Partial<ModelCapabilities> {
    return { reasoningContentField: "reasoning_content" };
  }

  protected override mapReasoningField(
    chunk: Record<string, unknown>,
    opts: GenerateOptions
  ): string | undefined {
    if (!this.thinkingEnabled(opts, this.#defaultEnableThinking)) return undefined;
    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
    const reasoning = delta?.reasoning_content;
    if (typeof reasoning === "string" && reasoning.length > 0) return reasoning;
    return undefined;
  }

  /**
   * Map ThinkingOptions to Qwen's enable_thinking + thinking_budget parameters.
   *
   * Qwen3 default is thinking ON — must explicitly pass false to disable.
   * thinking_budget is a token limit (not a tier name); default budget by effort.
   */
  protected override mapThinkingParams(opts: GenerateOptions): Record<string, unknown> {
    if (!this.#isThinkingModel) return {};
    const enabled = this.thinkingEnabled(opts, this.#defaultEnableThinking);
    const result: Record<string, unknown> = { enable_thinking: enabled };

    if (enabled) {
      const budget =
        opts.thinking?.budgetTokens ??
        (opts.thinking?.effort !== undefined
          ? QwenModel.EFFORT_BUDGET[opts.thinking.effort]
          : undefined);
      if (budget !== undefined) {
        result.thinking_budget = budget;
      }
    }

    return result;
  }

  protected override mapRequestParams(_opts: GenerateOptions): Record<string, unknown> {
    return {};
  }
}
