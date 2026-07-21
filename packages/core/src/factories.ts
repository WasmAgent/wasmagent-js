/**
 * Standalone factory functions for using core primitives in custom agent loops
 * without requiring ToolCallingAgent internals.
 *
 * These factories create pre-configured instances of ObservationalMemory,
 * CheckpointableRun, and TokenBudget that work independently of any agent class.
 *
 * @module factories
 *
 * @example Using TokenBudget in a custom loop:
 * ```ts
 * import { createTokenBudget } from "@wasmagent/core";
 *
 * const budget = createTokenBudget();
 * for await (const ev of model.generate(messages)) {
 *   if (ev.type === "usage" && ev.usage) budget.recordUsage(ev.usage);
 * }
 * console.log(`Cost: $${budget.estimatedUsdFor("claude-sonnet-4-6")}`);
 * ```
 *
 * @example Using ObservationalMemory in a custom loop:
 * ```ts
 * import { createObservationalMemory, MessageAssembler } from "@wasmagent/core";
 *
 * const assembler = new MessageAssembler({ systemPrompt: "You are helpful.", toolsSchema: [] });
 * const memory = createObservationalMemory({
 *   assembler,
 *   model: myModel,
 *   sessionId: "session-1",
 * });
 * // After each step:
 * assembler.addStep(step);
 * memory.noteStep();
 * ```
 *
 * @example Using CheckpointableRun in a custom loop:
 * ```ts
 * import { createCheckpointableRun, MessageAssembler, InMemoryCheckpointer } from "@wasmagent/core";
 *
 * const assembler = new MessageAssembler({ systemPrompt: "...", toolsSchema: [] });
 * const wrapper = createCheckpointableRun({
 *   checkpointer: new InMemoryCheckpointer(),
 *   assembler,
 * });
 * for await (const ev of wrapper.run(myGenerator, "task", "trace-id")) {
 *   // events are checkpointed automatically
 * }
 * ```
 */

import type { CheckpointableAgentOptions, Checkpointer } from "./checkpoint/index.js";
import { CheckpointableRun } from "./checkpoint/index.js";
import { MessageAssembler } from "./memory/MessageAssembler.js";
import type { ObservationalMemoryOptions } from "./memory/ObservationalMemory.js";
import { ObservationalMemory } from "./memory/ObservationalMemory.js";
import type { Model } from "./models/types.js";
import { TokenBudget } from "./models/types.js";

/**
 * Create a standalone TokenBudget for tracking token usage in custom agent loops.
 * Does not require ToolCallingAgent — works with any model.generate() call.
 */
export function createTokenBudget(): TokenBudget {
  return new TokenBudget();
}

/**
 * Create a standalone ObservationalMemory for use in custom agent loops.
 * Requires a MessageAssembler (which you can create independently) and a model.
 */
export function createObservationalMemory(opts: ObservationalMemoryOptions): ObservationalMemory {
  return new ObservationalMemory(opts);
}

/** Options for creating a standalone CheckpointableRun. */
export interface CreateCheckpointableRunOptions {
  checkpointer: Checkpointer;
  checkpointInterval?: number;
  assembler: MessageAssembler;
}

/**
 * Create a standalone CheckpointableRun wrapper for custom agent loops.
 * Wraps any AsyncGenerator<AgentEvent> with checkpoint-after-step and resume support.
 */
export function createCheckpointableRun(opts: CreateCheckpointableRunOptions): CheckpointableRun {
  const agentOpts: CheckpointableAgentOptions = {
    checkpointer: opts.checkpointer,
    ...(opts.checkpointInterval !== undefined
      ? { checkpointInterval: opts.checkpointInterval }
      : {}),
  };
  return new CheckpointableRun(agentOpts, opts.assembler);
}

/**
 * Create a standalone MessageAssembler for custom agent loops.
 * This is the primary dependency for ObservationalMemory and CheckpointableRun.
 */
export function createMessageAssembler(opts: {
  systemPrompt: string;
  toolsSchema?: object[];
}): MessageAssembler {
  return new MessageAssembler({
    systemPrompt: opts.systemPrompt,
    toolsSchema: opts.toolsSchema ?? [],
  });
}
