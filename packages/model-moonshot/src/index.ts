import { OpenAICompatModel, type OpenAICompatModelOptions } from "@agentkit-js/core/models";
import type { GenerateOptions, ModelCapabilities } from "@agentkit-js/core/models";

export const MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1";

/** Canonical Moonshot/Kimi model IDs. */
export const KimiModels = {
  V1_8K:    "moonshot-v1-8k",
  V1_32K:   "moonshot-v1-32k",
  V1_128K:  "moonshot-v1-128k",
  K2_6:     "kimi-k2-6",
  /** Always points to the latest recommended model. */
  LATEST:   "kimi-k2-6",
} as const;

export type KimiModelId = typeof KimiModels[keyof typeof KimiModels] | (string & {});

export interface MoonshotModelOptions extends OpenAICompatModelOptions {
  /**
   * Enable "preserve thinking" mode for K2.6 (long tool-call chains).
   * When true, the thinking content is preserved across tool calls.
   * Default: true for kimi-k2-6, false for v1-* models.
   */
  preserveThinking?: boolean;
}

/**
 * Moonshot (Kimi) model adapter.
 *
 * Kimi K2.6 (1T MoE) supports "preserve thinking" mode which keeps
 * reasoning context across 200-300 tool call steps. The reasoning text
 * arrives in `thinking_content` on the delta.
 */
export class MoonshotModel extends OpenAICompatModel {
  readonly #preserveThinking: boolean;

  constructor(
    modelId: KimiModelId,
    apiKeyOrOpts?: string | MoonshotModelOptions
  ) {
    const opts: MoonshotModelOptions = typeof apiKeyOrOpts === "string"
      ? { apiKey: apiKeyOrOpts }
      : (apiKeyOrOpts ?? {});
    const isK2 = modelId.includes("k2");
    super(modelId, MOONSHOT_BASE_URL, {
      ...opts,
      reasoningContentField: "thinking_content",
    });
    this.#preserveThinking = opts.preserveThinking ?? isK2;
  }

  protected override extraCapabilities(): Partial<ModelCapabilities> {
    return { reasoningContentField: "thinking_content" };
  }

  protected override mapReasoningField(chunk: Record<string, unknown>): string | undefined {
    if (!this.#preserveThinking) return undefined;
    const choices = chunk["choices"] as Array<Record<string, unknown>> | undefined;
    const delta = choices?.[0]?.["delta"] as Record<string, unknown> | undefined;
    const thinking = delta?.["thinking_content"];
    if (typeof thinking === "string" && thinking.length > 0) return thinking;
    return undefined;
  }

  protected override mapRequestParams(opts: GenerateOptions): Record<string, unknown> {
    if (this.#preserveThinking) {
      return { enable_thinking: true };
    }
    return {};
  }
}
