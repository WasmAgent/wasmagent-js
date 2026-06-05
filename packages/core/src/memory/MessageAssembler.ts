import type { ModelMessage } from "../models/types.js";
import type { Step } from "../types/events.js";

/**
 * Message assembler for cache-friendly prefix construction (B1).
 *
 * Produces a stable, byte-identical prefix from:
 *   [tools schema] + [system prompt] + [few-shot examples]  ← immutable, cache-breakpointed
 *   [stable history chunks]                                  ← filled segments, long-TTL cached
 *   [incremental tail]                                       ← current step, not cached
 *
 * Replaces smolagents' write_memory_to_messages (agents.py:758) which rebuilds
 * the full message list every step (O(steps) token growth, zero caching).
 */
export interface AssemblerConfig {
  systemPrompt: string;
  toolsSchema: object[];
  fewShotExamples?: ModelMessage[];
  /** Chunk size in steps before sealing a history segment for long-TTL caching (B2). */
  chunkSizeSteps?: number;
}

export class MessageAssembler {
  #config: AssemblerConfig;
  #history: Step[] = [];

  constructor(config: AssemblerConfig) {
    this.#config = config;
  }

  addStep(step: Step): void {
    this.#history.push(step);
  }

  /**
   * Build the full message list for the next model call.
   *
   * The immutable prefix (tools + system + few-shot) is always placed first
   * and ends with a cache breakpoint so Anthropic's prefix cache can save it.
   */
  build(): ModelMessage[] {
    const messages: ModelMessage[] = [];

    // 1. System prompt — immutable, always first.
    messages.push({
      role: "system",
      content: this.#buildSystemContent(),
      cacheBreakpoint: { afterBlockIndex: 0, type: "ephemeral" },
    });

    // 2. Few-shot examples — immutable.
    if (this.#config.fewShotExamples?.length) {
      messages.push(...this.#config.fewShotExamples);
    }

    // 3. History steps converted to messages.
    for (const step of this.#history) {
      messages.push(...this.#stepToMessages(step));
    }

    return messages;
  }

  reset(): void {
    this.#history = [];
  }

  /** Stable representation of system content + tools schema (B1 byte-stability). */
  #buildSystemContent(): string {
    const toolsJson = JSON.stringify(this.#config.toolsSchema, null, 0);
    return `${this.#config.systemPrompt}\n\n<tools>${toolsJson}</tools>`;
  }

  #stepToMessages(step: Step): ModelMessage[] {
    switch (step.type) {
      case "action":
        return [
          {
            role: "assistant",
            content: `<thoughts>${step.thoughts}</thoughts>\n<code>${step.code}</code>`,
          },
          {
            role: "user",
            content: `<observation>${step.observations}</observation>`,
          },
        ];
      case "planning":
        return [
          {
            role: "assistant",
            content: `<plan>${step.plan}</plan>\n<facts>${step.facts}</facts>`,
          },
        ];
      case "final_answer":
        return [];
    }
  }
}
