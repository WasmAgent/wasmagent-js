import type { GenerateOptions, ModelCapabilities } from "@wasmagent/core/models";
import { OpenAICompatModel, type OpenAICompatModelOptions } from "@wasmagent/core/models";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

/** Canonical DeepSeek model IDs. */
export const DeepSeekModels = {
  /**
   * @deprecated Will be retired 2026-07-24 15:59 UTC. Migrate to DeepSeekModels.V4_FLASH or V4_PRO.
   */
  CHAT: "deepseek-chat",
  /**
   * @deprecated Will be retired 2026-07-24 15:59 UTC. Migrate to DeepSeekModels.V4_PRO.
   */
  REASONER: "deepseek-reasoner",
  V4_PRO: "deepseek-v4-pro",
  V4_FLASH: "deepseek-v4-flash",
  /** Always points to the latest recommended model. */
  LATEST: "deepseek-v4-pro",
} as const;

export type DeepSeekModelId = (typeof DeepSeekModels)[keyof typeof DeepSeekModels] | (string & {});

export interface DeepSeekModelOptions extends OpenAICompatModelOptions {
  /**
   * Whether to include the think-step in the response for reasoner models.
   * Default: true (thinking is shown as thinking_delta stream events).
   */
  preserveThinking?: boolean;
  /**
   * Override the base URL. Default: DEEPSEEK_BASE_URL ("https://api.deepseek.com/v1").
   * Useful for an internal proxy or regional endpoint.
   */
  baseUrl?: string;
}

/**
 * DeepSeek model adapter.
 *
 * DeepSeek V3.1+/V4 supports thinking mode via `extra_body: { thinking: { type } }`.
 * - type: "enabled" | "disabled" (no "auto"; "adaptive" is downgraded to "enabled")
 * - effort: minimal/low/medium/standard → "high"; xhigh/max → "max" (DeepSeek's own mapping)
 * - Multi-turn: reasoning_content must be echoed back on tool-call turns only.
 *
 * @deprecated Models deepseek-chat and deepseek-reasoner retire 2026-07-24 — use V4_PRO/V4_FLASH.
 */
export class DeepSeekModel extends OpenAICompatModel {
  readonly #preserveThinking: boolean;

  constructor(modelId: DeepSeekModelId, apiKeyOrOpts?: string | DeepSeekModelOptions) {
    const opts: DeepSeekModelOptions =
      typeof apiKeyOrOpts === "string" ? { apiKey: apiKeyOrOpts } : (apiKeyOrOpts ?? {});
    super(modelId, opts.baseUrl ?? DEEPSEEK_BASE_URL, {
      ...opts,
      reasoningContentField: "reasoning_content",
    });
    this.#preserveThinking = opts.preserveThinking ?? true;
  }

  protected override extraCapabilities(): Partial<ModelCapabilities> {
    return { reasoningContentField: "reasoning_content" };
  }

  protected override reasoningRoundTripPolicy(): "never" | "tool-turns-only" | "always" {
    return "tool-turns-only";
  }

  /**
   * Extract DeepSeek's reasoning_content from the delta.
   * Suppressed when mode is "off" or preserveThinking is false.
   */
  protected override mapReasoningField(
    chunk: Record<string, unknown>,
    opts: GenerateOptions
  ): string | undefined {
    if (!this.#preserveThinking) return undefined;
    if (opts.thinking?.mode === "off") return undefined;
    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
    const reasoning = delta?.reasoning_content;
    if (typeof reasoning === "string" && reasoning.length > 0) return reasoning;
    return undefined;
  }

  /**
   * Map unified ThinkingOptions to DeepSeek's thinking:{type} via extra_body.
   *
   * Effort mapping (per DeepSeek docs): minimal/low/medium/standard → "high"; xhigh/max → "max".
   */
  protected override mapThinkingParams(opts: GenerateOptions): Record<string, unknown> {
    const mode = opts.thinking?.mode;
    const effort = opts.thinking?.effort;
    const budgetTokens = opts.thinking?.budgetTokens;

    if (mode === "off") {
      return { extra_body: { thinking: { type: "disabled" } } };
    }

    // DeepSeek has no "auto"; "adaptive" → "enabled"
    const thinkingObj: Record<string, unknown> = { type: "enabled" };

    if (effort !== undefined) {
      const effortMap: Record<string, string> = {
        minimal: "high",
        low: "high",
        standard: "high",
        medium: "high",
        high: "high",
        xhigh: "max",
        max: "max",
      };
      thinkingObj.effort = effortMap[effort] ?? "high";
    }
    if (budgetTokens !== undefined) {
      thinkingObj.budget_tokens = budgetTokens;
    }

    return { extra_body: { thinking: thinkingObj } };
  }

  protected override mapRequestParams(_opts: GenerateOptions): Record<string, unknown> {
    return {};
  }
}
