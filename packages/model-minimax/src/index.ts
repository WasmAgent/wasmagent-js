import { OpenAICompatModel, type OpenAICompatModelOptions } from "@agentkit-js/core/models";
import type { ModelCapabilities } from "@agentkit-js/core/models";

export const MINIMAX_BASE_URL = "https://api.minimax.chat/v1";

/** Canonical MiniMax model IDs. */
export const MiniMaxModels = {
  TEXT_01:  "minimax-text-01",
  M3:       "minimax-m3",
  /** Always points to the latest recommended model. */
  LATEST:   "minimax-m3",
} as const;

export type MiniMaxModelId = typeof MiniMaxModels[keyof typeof MiniMaxModels] | (string & {});

export type MiniMaxModelOptions = OpenAICompatModelOptions;

/**
 * MiniMax model adapter.
 *
 * MiniMax supports 1M token context (minimax-text-01) and an OpenAI-compatible
 * chat completions endpoint. No separate reasoning field — responses are standard.
 */
export class MiniMaxModel extends OpenAICompatModel {
  constructor(
    modelId: MiniMaxModelId,
    apiKeyOrOpts?: string | MiniMaxModelOptions
  ) {
    const opts: MiniMaxModelOptions = typeof apiKeyOrOpts === "string"
      ? { apiKey: apiKeyOrOpts }
      : (apiKeyOrOpts ?? {});
    super(modelId, MINIMAX_BASE_URL, opts);
  }

  protected override extraCapabilities(): Partial<ModelCapabilities> {
    return {};
  }
}
