import type { ModelMessage } from "../models/types.js";
import type { Step } from "../types/events.js";

/**
 * Message assembler for cache-friendly prefix construction (B1/B2).
 *
 * Produces a stable, byte-identical prefix from:
 *   [tools schema] + [system prompt] + [few-shot examples]  ← immutable, cache-breakpointed (B1)
 *   [stable history chunks]                                  ← filled segments, cache-breakpointed (B2)
 *   [incremental tail]                                       ← current step, not cached
 *
 * B2 segment caching: once the history reaches a multiple of chunkSizeSteps,
 * the last message in that completed chunk gets a cache breakpoint. The prefix
 * up to that point is byte-identical across future steps and qualifies for
 * Anthropic's long-TTL (5 min) prompt cache.
 *
 * Replaces smolagents' write_memory_to_messages (agents.py:758) which rebuilds
 * the full message list every step (O(steps) token growth, zero caching).
 */
export interface AssemblerConfig {
  systemPrompt: string;
  toolsSchema: object[];
  fewShotExamples?: ModelMessage[];
  /**
   * Chunk size in steps before sealing a history segment with a cache breakpoint (B2).
   * Default: 0 (disabled — only the system prefix is cached).
   * Recommended: 5–10 for long-running agents.
   */
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
   * Completed history chunks are also breakpointed (B2).
   */
  build(): ModelMessage[] {
    const messages: ModelMessage[] = [];

    // 1. System prompt — immutable, always first (B1).
    messages.push({
      role: "system",
      content: this.#buildSystemContent(),
      cacheBreakpoint: { afterBlockIndex: 0, type: "ephemeral" },
    });

    // 2. Few-shot examples — immutable.
    if (this.#config.fewShotExamples?.length) {
      messages.push(...this.#config.fewShotExamples);
    }

    // 3. History steps converted to messages, with B2 chunk breakpoints.
    const chunkSize = this.#config.chunkSizeSteps ?? 0;
    // Count only action steps (not planning/final) for chunking — they're
    // the ones that grow the history uniformly.
    const actionStepIndices: number[] = [];
    const allMessages: ModelMessage[][] = this.#history.map((step, i) => {
      if (step.type === "action") actionStepIndices.push(i);
      return this.#stepToMessages(step);
    });

    // Determine which history entries end a chunk (B2).
    const sealedChunkEnds = new Set<number>();
    if (chunkSize > 0) {
      for (let chunk = chunkSize; chunk <= actionStepIndices.length; chunk += chunkSize) {
        // The chunk boundary falls after the (chunk)-th action step.
        const idx = actionStepIndices[chunk - 1];
        if (idx !== undefined) sealedChunkEnds.add(idx);
      }
    }

    for (let i = 0; i < allMessages.length; i++) {
      const stepMsgs = allMessages[i];
      if (!stepMsgs || stepMsgs.length === 0) continue;

      if (sealedChunkEnds.has(i)) {
        // Seal this chunk: add breakpoint to the last message in the group (B2).
        const sealed = [...stepMsgs];
        const last = sealed[sealed.length - 1];
        if (last) {
          sealed[sealed.length - 1] = {
            ...last,
            cacheBreakpoint: { afterBlockIndex: 0, type: "ephemeral" },
          };
        }
        messages.push(...sealed);
      } else {
        messages.push(...stepMsgs);
      }
    }

    return messages;
  }

  reset(): void {
    this.#history = [];
  }

  /** Returns the number of completed sealed chunks in the current history (B2). */
  get sealedChunkCount(): number {
    const chunkSize = this.#config.chunkSizeSteps ?? 0;
    if (chunkSize === 0) return 0;
    const actionCount = this.#history.filter((s) => s.type === "action" || s.type === "tool_use" || s.type === "parallel_tool_use").length;
    return Math.floor(actionCount / chunkSize);
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
      case "tool_use":
        // Produce the assistant tool_use block + user tool_result block required
        // by the Anthropic and OpenAI multi-turn tool conversation format.
        return [
          {
            role: "assistant",
            content: [
              ...(step.thoughts
                ? [{ type: "text" as const, text: step.thoughts }]
                : []),
              {
                type: "tool_use" as const,
                id: step.toolCallId,
                name: step.toolName,
                input: step.toolInput,
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result" as const,
                toolUseId: step.toolCallId,
                content: step.toolOutput || "Tool execution failed with no output.",
                ...(step.isError ? { isError: true as const } : {}),
              },
            ],
          },
        ];
      case "parallel_tool_use":
        // One assistant message with N tool_use blocks + one user message with N
        // tool_result blocks in matching order — required by the Anthropic API
        // when the model calls multiple tools in a single turn.
        return [
          {
            role: "assistant",
            content: [
              ...(step.thoughts
                ? [{ type: "text" as const, text: step.thoughts }]
                : []),
              ...step.calls.map((c) => ({
                type: "tool_use" as const,
                id: c.toolCallId,
                name: c.toolName,
                input: c.toolInput,
              })),
            ],
          },
          {
            role: "user",
            content: step.calls.map((c) => ({
              type: "tool_result" as const,
              toolUseId: c.toolCallId,
              content: c.toolOutput || "Tool execution failed with no output.",
              ...(c.isError ? { isError: true as const } : {}),
            })),
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
      case "user_message":
        return [{ role: "user", content: step.content }];
    }
  }
}
