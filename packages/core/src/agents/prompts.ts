/**
 * Shared prompt constants and planning utilities used by CodeAgent and ToolCallingAgent.
 */

import type { MessageAssembler } from "../memory/MessageAssembler.js";
import type { Model, TokenBudget } from "../models/types.js";
import type { AgentEvent, PlanningStep } from "../types/events.js";

/**
 * Tool dependency reference instructions injected into the default system prompt.
 *
 * These instructions teach the model to express cross-call data dependencies using
 * the $<callId> reference syntax consumed by deriveDependencies() in the DAG scheduler.
 * When a model uses this syntax, the scheduler correctly builds dependency edges,
 * enabling speculative execution of readOnly nodes and proper write barriers.
 *
 * Without these instructions, deriveDependencies() returns empty deps for every call,
 * making the DAG scheduler equivalent to plain Promise.all parallel execution.
 */
export const TOOL_DEP_INSTRUCTIONS = `
When multiple tool calls are needed and one call's input depends on another call's output, express the dependency by using \`$<callId>\` as the input value, where <callId> is the id of the call whose output is needed.

Example:
- Call search (id: "search-1") to look up a value
- Call transform (id: "transform-1") with input: { "value": "$search-1" } to use search's output

Rules:
- Only use \`$<id>\` when the input genuinely requires the other call's output
- Independent calls should NOT use \`$\` references — they will run in parallel
- The \`$<id>\` reference must match an id of another tool call in the same batch`;

export const PLANNING_PROMPT = `Based on the task and observations so far, provide:
1. A structured plan for remaining steps (inside <plan>...</plan> tags)
2. Key facts established so far (inside <facts>...</facts> tags)`;

/**
 * Shared planning step implementation for CodeAgent and ToolCallingAgent.
 * Queries the model with PLANNING_PROMPT, parses plan/facts from the response,
 * records the planning step in history, and yields a planning event.
 */
export async function* runPlanningStep(
  traceId: string,
  parentTraceId: string | null,
  step: number,
  model: Model,
  assembler: MessageAssembler,
  budget: TokenBudget
): AsyncGenerator<AgentEvent> {
  const planningMessages = assembler.build();
  planningMessages.push({ role: "user", content: PLANNING_PROMPT });

  let planResponse = "";
  let planReceivedUsage = false;
  for await (const ev of model.generate(planningMessages, { stream: true })) {
    if (ev.type === "text_delta" && ev.delta) {
      planResponse += ev.delta;
    } else if (ev.type === "usage" && ev.usage) {
      budget.recordUsage(ev.usage);
      planReceivedUsage = true;
    }
  }
  if (!planReceivedUsage) budget.estimateFallback(planningMessages, planResponse);

  const plan = extractTagContent(planResponse, "plan") ?? planResponse;
  const facts = extractTagContent(planResponse, "facts") ?? "";

  const planningStep: PlanningStep = { type: "planning", plan, facts };
  assembler.addStep(planningStep);

  yield {
    traceId,
    parentTraceId,
    channel: "thinking",
    event: "planning",
    data: { step, plan, facts },
    timestampMs: Date.now(),
  };
}

/** Extracts content between XML-style tags, e.g. <plan>...</plan>. */
export function extractTagContent(text: string, tag: string): string | null {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<${escapedTag}>([\\s\\S]*?)<\\/${escapedTag}>`).exec(text);
  return match?.[1]?.trim() ?? null;
}
