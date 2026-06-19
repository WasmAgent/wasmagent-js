/**
 * Sub-agent wrapping primitive.
 *
 * Turns any agent (object with a run() generator method) into a ToolDefinition
 * so it can be invoked by a parent ToolCallingAgent.
 *
 * Usage:
 *   const searchAgent = new ToolCallingAgent({ ... });
 *   const parentAgent = new ToolCallingAgent({
 *     tools: [asTool(searchAgent, { name: "search_agent", description: "..." })],
 *     model,
 *   });
 *
 * Sub-agent events carry the parent's traceId as parentTraceId, so the full
 * event chain can be correlated by the caller.
 */

import { z } from "zod";
import type { ToolDefinition } from "../tools/types.js";
import type { AgentEvent } from "../types/events.js";

export interface AsToolOptions {
  /** Tool name exposed to the parent model. */
  name: string;
  /** Tool description exposed to the parent model. */
  description: string;
  /**
   * Optional: collect sub-agent events for observability.
   * Called with each AgentEvent emitted by the sub-agent.
   */
  onEvent?: (event: AgentEvent) => void;
  /**
   * Optional mutable ref whose `.current` value is read at call time and
   * forwarded to the sub-agent as its parentTraceId.  Set this to the
   * parent agent's own traceId ref so that sub-agent events are linked
   * to the correct parent trace in observability consumers.
   */
  parentTraceIdRef?: { current: string | null };
}

export interface SubagentRunnable {
  run(task: string, parentTraceId?: string | null): AsyncGenerator<AgentEvent>;
}

/**
 * Wrap an agent as a ToolDefinition for use inside a parent ToolCallingAgent.
 *
 * The sub-agent receives the tool input's `task` field as its task string and
 * the parent agent's traceId as its parentTraceId (linking event chains).
 *
 * Returns the sub-agent's final answer as the tool output. If the sub-agent
 * errors, the error message is propagated as a tool error.
 */
export function asTool(
  agent: SubagentRunnable,
  opts: AsToolOptions
  // biome-ignore lint/suspicious/noExplicitAny: intentional
): ToolDefinition<{ task: string }, any> {
  return {
    name: opts.name,
    description: opts.description,
    inputSchema: z.object({ task: z.string().describe("The task for the sub-agent to perform") }),
    outputSchema: z.object({ answer: z.any() }),
    readOnly: false,
    idempotent: false,
    async forward(input, _signal) {
      let finalAnswer: unknown = null;
      let errorMessage: string | null = null;

      for await (const event of agent.run(input.task, opts.parentTraceIdRef?.current ?? null)) {
        opts.onEvent?.(event);
        if (event.event === "final_answer") {
          finalAnswer = event.data.answer;
        } else if (event.event === "error") {
          errorMessage = event.data.error;
        }
      }

      if (errorMessage !== null) {
        throw new Error(`Sub-agent "${opts.name}" failed: ${errorMessage}`);
      }

      return { answer: finalAnswer };
    },
  };
}
