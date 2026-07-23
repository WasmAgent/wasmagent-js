import type { GenerateOptions, ModelCapabilities } from "@wasmagent/core/models";
import { OpenAICompatModel, type OpenAICompatModelOptions } from "./OpenAICompatModel.js";

export const DOUBAO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

/** Canonical Doubao (Volcengine Ark) model IDs. */
export const DoubaoModels = {
  SEED_1_6: "doubao-seed-1-6-251015",
  SEED_1_6_THINKING: "doubao-seed-1-6-thinking",
  THINKING_PRO_1_5: "doubao-1-5-thinking-pro",
  SEED_2_0_PRO: "doubao-seed-2-0-pro",
  /** Doubao Seed 2.0 economy tier (released 2026-02-15). */
  SEED_2_0_LITE: "doubao-seed-2-0-lite-260215",
  /** Always points to the latest recommended model (Seed 2.0 Pro as of 2026-06). */
  LATEST: "doubao-seed-2-0-pro",
} as const;

export type DoubaoModelId = (typeof DoubaoModels)[keyof typeof DoubaoModels] | (string & {});

/** Doubao Seed-1.6 thinking length tiers (Minimal/Low/Medium/High). */
const EFFORT_TO_THINKING_LEVEL: Record<string, string> = {
  none: "minimal",
  minimal: "minimal",
  low: "low",
  standard: "medium",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

/** Model IDs that support adaptive ("auto") thinking type. */
const AUTO_CAPABLE_MODELS = new Set<string>(["doubao-seed-2-0-pro", "doubao-seed-2-0-lite-260215"]);

/** Model IDs that support thinking/reasoning. */
const REASONING_MODELS = new Set<string>([
  "doubao-seed-1-6-251015",
  "doubao-seed-1-6-thinking",
  "doubao-1-5-thinking-pro",
  "doubao-seed-2-0-pro",
  "doubao-seed-2-0-lite-260215",
]);

export interface DoubaoModelOptions extends OpenAICompatModelOptions {
  /**
   * Enable Ark explicit Context API caching (context_id + per-hour storage cost).
   * Default: false (transparent prefix caching is always-on and zero-config).
   */
  useContextApi?: boolean;
  /**
   * Override the Volcengine Ark base URL.
   * Default: DOUBAO_BASE_URL ("https://ark.cn-beijing.volces.com/api/v3").
   * Useful for a regional endpoint or internal proxy.
   */
  baseUrl?: string;
}

/**
 * Doubao (Volcengine Ark) model adapter.
 *
 * Doubao-Seed-1.6 and related models expose an OpenAI-compatible endpoint at
 * ark.cn-beijing.volces.com with these differences:
 *
 * - Thinking: structured `thinking:{type,level}` in `extra_body`, not a flat param.
 * - Thinking tiers: Minimal/Low/Medium/High map to ReasoningEffort values.
 * - Reasoning text: returned in `reasoning_content` on the delta (same as DeepSeek).
 * - Multi-turn: reasoning_content must be echoed back in subsequent messages.
 * - Caching: transparent prefix caching (auto-prefix) is always-on; explicit
 *   Context API (ark-context) available via useContextApi option.
 */
export class DoubaoModel extends OpenAICompatModel {
  constructor(modelId: DoubaoModelId, apiKeyOrOpts?: string | DoubaoModelOptions) {
    const opts: DoubaoModelOptions =
      typeof apiKeyOrOpts === "string" ? { apiKey: apiKeyOrOpts } : (apiKeyOrOpts ?? {});
    super(modelId, opts.baseUrl ?? DOUBAO_BASE_URL, {
      ...opts,
      reasoningContentField: "reasoning_content",
      supportsReasoningEffort: true,
      cacheStrategy: (opts.useContextApi ?? false) ? "ark-context" : "auto-prefix",
    });
  }

  protected override extraCapabilities(): Partial<ModelCapabilities> {
    return { reasoningContentField: "reasoning_content" };
  }

  protected override reasoningRoundTripPolicy(): "never" | "tool-turns-only" | "always" {
    return "tool-turns-only";
  }

  /**
   * Extract Doubao's reasoning_content from the delta.
   * Suppressed when mode is "off".
   */
  protected override mapReasoningField(
    chunk: Record<string, unknown>,
    opts: GenerateOptions
  ): string | undefined {
    if (opts.thinking?.mode === "off") return undefined;
    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
    const reasoning = delta?.reasoning_content;
    if (typeof reasoning === "string" && reasoning.length > 0) return reasoning;
    return undefined;
  }

  /**
   * Map unified ThinkingOptions to Doubao's structured thinking parameter.
   *
   * Doubao uses `extra_body: { thinking: { type, level } }`:
   * - type: "enabled" | "disabled" | "auto" (auto only on select models)
   * - level: "minimal" | "low" | "medium" | "high" (maps from ReasoningEffort)
   */
  protected override mapThinkingParams(opts: GenerateOptions): Record<string, unknown> {
    const mode = opts.thinking?.mode;
    const effort = opts.thinking?.effort;
    const budgetTokens = opts.thinking?.budgetTokens;

    // Only reasoning-capable models accept the thinking parameter.
    if (!REASONING_MODELS.has(this.modelId)) return {};

    if (mode === "off") {
      return { extra_body: { thinking: { type: "disabled" } } };
    }

    let type: string;
    if (mode === "adaptive") {
      type = AUTO_CAPABLE_MODELS.has(this.modelId) ? "auto" : "enabled";
    } else {
      type = "enabled";
    }

    const thinkingObj: Record<string, unknown> = { type };

    if (effort !== undefined) {
      thinkingObj.level = EFFORT_TO_THINKING_LEVEL[effort] ?? "medium";
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
