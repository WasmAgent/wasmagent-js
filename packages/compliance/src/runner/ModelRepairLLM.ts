/**
 * ModelRepairLLM — adapter that wraps any `@wasmagent/core` `Model`
 * into the local `RepairLLM` interface.
 *
 * # Why this lives in runner/, not repair/
 *
 * `repair/` is the strategy + planner core. It depends only on the
 * minimal `RepairLLM` shape so strategies can be unit-tested with a
 * fake. The adapter that crosses the boundary into `@wasmagent/core`'s
 * full Model surface (streaming, tool calls, message roles, …) lives
 * here in `runner/`, which is the orchestration layer that's allowed
 * to know about both sides.
 *
 * # Stream consumption
 *
 * `Model.generate` returns an `AsyncGenerator<StreamEvent>` with
 * `text_delta`, `thinking_delta`, `tool_call`, `stop`, `usage` events.
 * For repair we want just the text response, so we concatenate
 * `text_delta` deltas and ignore the rest. `thinking_delta` is dropped
 * — repair prompts don't need the model's chain of thought in the
 * final artifact. `usage` is captured for the trace.
 *
 * # Why we do not pass tools
 *
 * Repair calls are pure text rewrites — no tools, no MCP, no
 * structured output. The strategies build the prompt with all the
 * structure they need; forcing a tool-call response shape would only
 * complicate parsing.
 */

import type { Model, ModelMessage } from "@wasmagent/core/models";
import type { RepairLLM, RepairLLMRequest, RepairLLMResponse } from "../repair/RepairLLM.js";

export interface ModelRepairLLMOptions {
  model: Model;
  /**
   * Optional system prompt prepended to every repair request. Default:
   * a short instruction that tells the model to output only the
   * rewritten text. Set to `null` to disable.
   */
  systemPrompt?: string | null;
}

const DEFAULT_SYSTEM_PROMPT =
  "You rewrite text responses so they satisfy the given constraints. " +
  "Output ONLY the new response — no explanation, no markdown fences, no JSON wrapper.";

export class ModelRepairLLM implements RepairLLM {
  readonly #model: Model;
  readonly #systemPrompt: string | null;

  constructor(opts: ModelRepairLLMOptions) {
    this.#model = opts.model;
    this.#systemPrompt =
      opts.systemPrompt === undefined ? DEFAULT_SYSTEM_PROMPT : opts.systemPrompt;
  }

  async complete(request: RepairLLMRequest): Promise<RepairLLMResponse> {
    const messages: ModelMessage[] = [];
    if (this.#systemPrompt !== null) {
      messages.push({ role: "system", content: this.#systemPrompt });
    }
    messages.push({ role: "user", content: request.prompt });

    const generateOpts: { maxTokens?: number; temperature?: number } = {};
    if (request.max_tokens !== undefined) generateOpts.maxTokens = request.max_tokens;
    if (request.temperature !== undefined) generateOpts.temperature = request.temperature;

    let text = "";
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    for await (const ev of this.#model.generate(messages, generateOpts)) {
      if (ev.type === "text_delta" && ev.delta) {
        text += ev.delta;
      } else if (ev.type === "usage" && ev.usage) {
        // Provider naming varies — try the common fields.
        const u = ev.usage as unknown as Record<string, unknown>;
        const inT = u.inputTokens ?? u.input_tokens ?? u.promptTokens ?? u.prompt_tokens;
        const outT = u.outputTokens ?? u.output_tokens ?? u.completionTokens ?? u.completion_tokens;
        if (typeof inT === "number") promptTokens = inT;
        if (typeof outT === "number") completionTokens = outT;
      }
    }

    const response: RepairLLMResponse = { text };
    if (promptTokens !== undefined || completionTokens !== undefined) {
      response.usage = {};
      if (promptTokens !== undefined) response.usage.prompt_tokens = promptTokens;
      if (completionTokens !== undefined) response.usage.completion_tokens = completionTokens;
    }
    return response;
  }
}
