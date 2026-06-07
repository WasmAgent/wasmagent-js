import { OpenAICompatModel, type OpenAICompatModelOptions } from "@agentkit-js/core/models";
import type { GenerateOptions, ModelCapabilities } from "@agentkit-js/core/models";

export const ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

/** Canonical Zhipu (GLM) model IDs. */
export const GLMModels = {
  GLM_4_PLUS:  "glm-4-plus",
  GLM_4_AIR:   "glm-4-air",
  GLM_5_1:     "glm-5-1",
  /** Always points to the latest recommended model. */
  LATEST:      "glm-5-1",
} as const;

export type GLMModelId = typeof GLMModels[keyof typeof GLMModels] | (string & {});

export interface ZhipuModelOptions extends OpenAICompatModelOptions {
  /** Enable GLM thinking mode. Default: true for glm-5-* models. */
  enableThinking?: boolean;
}

/**
 * Zhipu (GLM) model adapter.
 *
 * GLM-5.1 (200K context) supports a thinking mode enabled via the
 * `enable_thinking` request parameter. Reasoning text arrives in
 * `reasoning_content` on the response delta.
 * Runtime opts.thinking.mode overrides the constructor-time default.
 */
export class ZhipuModel extends OpenAICompatModel {
  readonly #defaultEnableThinking: boolean;

  constructor(
    modelId: GLMModelId,
    apiKeyOrOpts?: string | ZhipuModelOptions
  ) {
    const opts: ZhipuModelOptions = typeof apiKeyOrOpts === "string"
      ? { apiKey: apiKeyOrOpts }
      : (apiKeyOrOpts ?? {});
    const isThinkingModel = modelId.startsWith("glm-5");
    super(modelId, ZHIPU_BASE_URL, {
      ...opts,
      reasoningContentField: "reasoning_content",
    });
    this.#defaultEnableThinking = opts.enableThinking ?? isThinkingModel;
  }

  protected override extraCapabilities(): Partial<ModelCapabilities> {
    return { reasoningContentField: "reasoning_content" };
  }

  protected override mapReasoningField(chunk: Record<string, unknown>, opts: GenerateOptions): string | undefined {
    if (!this.thinkingEnabled(opts, this.#defaultEnableThinking)) return undefined;
    const choices = chunk["choices"] as Array<Record<string, unknown>> | undefined;
    const delta = choices?.[0]?.["delta"] as Record<string, unknown> | undefined;
    const reasoning = delta?.["reasoning_content"];
    if (typeof reasoning === "string" && reasoning.length > 0) return reasoning;
    return undefined;
  }

  protected override mapThinkingParams(opts: GenerateOptions): Record<string, unknown> {
    const enabled = this.thinkingEnabled(opts, this.#defaultEnableThinking);
    return { enable_thinking: enabled };
  }

  protected override mapRequestParams(_opts: GenerateOptions): Record<string, unknown> {
    return {};
  }
}
