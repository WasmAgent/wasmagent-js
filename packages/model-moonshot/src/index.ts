import { OpenAICompatModel, type OpenAICompatModelOptions } from "@agentkit-js/core/models";
import type { GenerateOptions, ModelCapabilities } from "@agentkit-js/core/models";

export const MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1";

/** Canonical Moonshot/Kimi model IDs. */
export const KimiModels = {
  V1_8K:    "moonshot-v1-8k",
  V1_32K:   "moonshot-v1-32k",
  V1_128K:  "moonshot-v1-128k",
  K2_6:     "kimi-k2-6",
  /** kimi-k2.6 (note dot) — current flagship with 262K context. */
  K2_6_DOT: "kimi-k2.6",
  /** Always points to the latest recommended model. */
  LATEST:   "kimi-k2.6",
} as const;

export type KimiModelId = typeof KimiModels[keyof typeof KimiModels] | (string & {});

export interface MoonshotModelOptions extends OpenAICompatModelOptions {
  /**
   * Enable "preserve thinking" mode for K2.6 (long tool-call chains).
   * Default: true for kimi-k2* models, false for v1-* models.
   */
  preserveThinking?: boolean;
}

/**
 * Moonshot (Kimi) model adapter.
 *
 * Kimi K2.6 (262K context, 1T MoE) supports thinking mode via `extra_body: { thinking: { type } }`.
 * - K2.6: reasoning text in `delta.reasoning` field.
 * - K2 / K2.5: reasoning text in `delta.reasoning_content` field.
 * - Multi-turn tool chains: reasoning_content must be echoed back on tool-call turns.
 */
export class MoonshotModel extends OpenAICompatModel {
  readonly #preserveThinking: boolean;
  readonly #isK26: boolean;

  constructor(
    modelId: KimiModelId,
    apiKeyOrOpts?: string | MoonshotModelOptions
  ) {
    const opts: MoonshotModelOptions = typeof apiKeyOrOpts === "string"
      ? { apiKey: apiKeyOrOpts }
      : (apiKeyOrOpts ?? {});
    const isK2 = modelId.includes("k2");
    // K2.6 (with dot) uses "reasoning" field; older K2/K2.5 use "reasoning_content".
    const isK26 = modelId.includes("k2.6") || modelId === "kimi-k2.6";
    super(modelId, MOONSHOT_BASE_URL, {
      ...opts,
      // Field name used for capability metadata; actual extraction is version-aware in mapReasoningField.
      reasoningContentField: isK26 ? "reasoning" : "reasoning_content",
    });
    this.#preserveThinking = opts.preserveThinking ?? isK2;
    this.#isK26 = isK26;
  }

  protected override extraCapabilities(): Partial<ModelCapabilities> {
    // Note: #isK26 is not available when extraCapabilities() is called from
    // the base class constructor. The reasoningContentField is passed via
    // OpenAICompatModelOptions instead, so this just returns an empty object.
    return {};
  }

  protected override reasoningRoundTripPolicy(): "never" | "tool-turns-only" | "always" {
    return this.#preserveThinking ? "tool-turns-only" : "never";
  }

  /**
   * Extract Kimi's reasoning text.
   * K2.6+: uses `delta.reasoning` field.
   * K2/K2.5: uses `delta.reasoning_content` field.
   */
  protected override mapReasoningField(chunk: Record<string, unknown>, opts: GenerateOptions): string | undefined {
    if (!this.#preserveThinking) return undefined;
    if (opts.thinking?.mode === "off") return undefined;
    const choices = chunk["choices"] as Array<Record<string, unknown>> | undefined;
    const delta = choices?.[0]?.["delta"] as Record<string, unknown> | undefined;
    if (this.#isK26) {
      const reasoning = delta?.["reasoning"];
      if (typeof reasoning === "string" && reasoning.length > 0) return reasoning;
      return undefined;
    }
    // K2/K2.5: reasoning_content
    const reasoning = delta?.["reasoning_content"];
    if (typeof reasoning === "string" && reasoning.length > 0) return reasoning;
    return undefined;
  }

  /**
   * Map ThinkingOptions to Kimi's thinking:{type} via extra_body.
   * Kimi supports "enabled" and "disabled"; "adaptive" → "enabled".
   */
  protected override mapThinkingParams(opts: GenerateOptions): Record<string, unknown> {
    const mode = opts.thinking?.mode;

    if (mode === "off") {
      return { extra_body: { thinking: { type: "disabled" } } };
    }

    if (!this.#preserveThinking && mode === undefined) {
      return {};
    }

    return { extra_body: { thinking: { type: "enabled" } } };
  }

  protected override mapRequestParams(_opts: GenerateOptions): Record<string, unknown> {
    return {};
  }
}
