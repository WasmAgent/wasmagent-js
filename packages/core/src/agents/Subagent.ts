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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

      for await (const event of agent.run(input.task, null)) {
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
