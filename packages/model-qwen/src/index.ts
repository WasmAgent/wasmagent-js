import { OpenAICompatModel, type OpenAICompatModelOptions } from "@agentkit-js/core/models";
import type { GenerateOptions, ModelCapabilities } from "@agentkit-js/core/models";

export const QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/** Canonical Qwen (Alibaba) model IDs. */
export const QwenModels = {
  QWEN3_MAX:    "qwen3-max",
  QWEN3_PLUS:   "qwen3-plus",
  QWEN3_TURBO:  "qwen3-turbo",
  QWEN2_5_72B:  "qwen2.5-72b-instruct",
  /** Always points to the latest recommended model. */
  LATEST:       "qwen3-max",
} as const;

export type QwenModelId = typeof QwenModels[keyof typeof QwenModels] | (string & {});

export interface QwenModelOptions extends OpenAICompatModelOptions {
  /** Enable thinking mode for Qwen3 models. Default: true for qwen3-* models. */
  enableThinking?: boolean;
}

/**
 * Qwen (Alibaba DashScope) model adapter.
 *
 * Qwen3-Max/Plus (262K–1M context) supports thinking via `enable_thinking`
 * parameter. Reasoning text appears in `reasoning_content` on the delta.
 */
export class QwenModel extends OpenAICompatModel {
  readonly #enableThinking: boolean;

  constructor(
    modelId: QwenModelId,
    apiKeyOrOpts?: string | QwenModelOptions
  ) {
    const opts: QwenModelOptions = typeof apiKeyOrOpts === "string"
      ? { apiKey: apiKeyOrOpts }
      : (apiKeyOrOpts ?? {});
    const isThinkingModel = modelId.startsWith("qwen3");
    super(modelId, QWEN_BASE_URL, {
      ...opts,
      reasoningContentField: "reasoning_content",
    });
    this.#enableThinking = opts.enableThinking ?? isThinkingModel;
  }

  protected override extraCapabilities(): Partial<ModelCapabilities> {
    return { reasoningContentField: "reasoning_content" };
  }

  protected override mapReasoningField(chunk: Record<string, unknown>): string | undefined {
    if (!this.#enableThinking) return undefined;
    const choices = chunk["choices"] as Array<Record<string, unknown>> | undefined;
    const delta = choices?.[0]?.["delta"] as Record<string, unknown> | undefined;
    const reasoning = delta?.["reasoning_content"];
    if (typeof reasoning === "string" && reasoning.length > 0) return reasoning;
    return undefined;
  }

  protected override mapRequestParams(_opts: GenerateOptions): Record<string, unknown> {
    if (this.#enableThinking) {
      return { enable_thinking: true };
    }
    return {};
  }
}
