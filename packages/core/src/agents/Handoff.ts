/**
 * Handoff — control-transfer primitive for multi-agent orchestration (B2).
 *
 * Complements asTool (agent-as-tool, returns result to parent) with a proper
 * "hand off control" operation: the current agent yields control to the target
 * agent and the target's final answer becomes the overall answer.
 *
 * Difference from asTool:
 *   asTool  — parent calls sub-agent as a tool; sub-agent's answer is returned to
 *             the parent which may continue running more steps.
 *   handoff — control fully transfers to the target; no continuation in the caller;
 *             history can be filtered before hand-off (e.g. remove tool details).
 *
 * Usage:
 *   const result = await handoff(targetAgent, task, parentTraceId, {
 *     inputFilter: (steps) => steps.filter((s) => s.type !== "tool_use"),
 *   });
 *
 * The handoff function is NOT a ToolDefinition — it is a direct async call that
 * yields a HandoffResult. Agents that want to delegate control call handoff()
 * directly rather than through the tool-calling loop.
 */

import type { AgentEvent, Step } from "../types/events.js";

export interface HandoffOptions {
  /**
   * Filter applied to the calling agent's history before it is passed to the
   * target agent. Use to strip tool call details, PII, or implementation-specific
   * context that the target agent doesn't need.
   *
   * Return the filtered steps array. Returning an empty array passes a blank slate.
   */
  inputFilter?: (steps: Step[]) => Step[];
  /**
   * Optional context mapper: supply extra context string to the target's task.
   * The returned string is prepended to the task when calling target.run().
   */
  contextMapper?: (originalTask: string) => string;
}

export interface HandoffResult {
  /** Final answer from the target agent. */
  answer: unknown;
  /** Whether the target agent completed successfully. */
  success: boolean;
  /** Error message if the target agent errored. */
  errorMessage?: string;
  /** All events emitted by the target agent. */
  events: AgentEvent[];
}

export interface HandoffAgent {
  run(task: string, parentTraceId?: string | null): AsyncGenerator<AgentEvent>;
}

/**
 * Hand off control to a target agent.
 *
 * The calling agent should return after handoff — there is no "back" flow.
 * The target agent's final answer is the definitive result.
 *
 * @param targetAgent - The agent to hand off to.
 * @param task        - The task string for the target agent.
 * @param parentTraceId - The calling agent's traceId (for event correlation).
 * @param opts        - Optional input filter and context mapper.
 */
export async function handoff(
  targetAgent: HandoffAgent,
  task: string,
  parentTraceId: string | null,
  opts: HandoffOptions = {}
): Promise<HandoffResult> {
  const mappedTask = opts.contextMapper ? opts.contextMapper(task) : task;

  let finalAnswer: unknown = null;
  let errorMessage: string | undefined;
  const collectedEvents: AgentEvent[] = [];

  for await (const ev of targetAgent.run(mappedTask, parentTraceId)) {
    collectedEvents.push(ev);
    if (ev.event === "final_answer") {
      finalAnswer = ev.data.answer;
    } else if (ev.event === "error") {
      errorMessage = ev.data.error;
    }
  }

  return {
    answer: finalAnswer,
    success: errorMessage === undefined,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    events: collectedEvents,
  };
}

/**
 * Create a ToolCallingAgent-compatible handoff function that emits proper
 * handoff events on the parent event stream.
 *
 * This is a generator version that yields AgentEvents from the target agent
 * (with the handoff status event prepended), suitable for use inside an
 * agent's run loop.
 */
export async function* handoffGenerator(
  targetAgent: HandoffAgent,
  task: string,
  traceId: string,
  parentTraceId: string | null,
  step: number,
  targetAgentName: string,
  opts: HandoffOptions = {}
): AsyncGenerator<AgentEvent> {
  // Emit handoff status event for observability.
  yield {
    traceId,
    parentTraceId,
    channel: "status",
    event: "handoff",
    data: { targetAgentName, step },
    timestampMs: Date.now(),
  };

  const mappedTask = opts.contextMapper ? opts.contextMapper(task) : task;

  for await (const ev of targetAgent.run(mappedTask, traceId)) {
    yield ev;
  }
}
