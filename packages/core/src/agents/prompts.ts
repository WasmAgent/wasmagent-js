/**
 * Shared prompt constants and planning utilities used by CodeAgent and ToolCallingAgent.
 */

import type { Model, TokenBudget } from "../models/types.js";
import type { MessageAssembler } from "../memory/MessageAssembler.js";
import type { AgentEvent, PlanningStep } from "../types/events.js";

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
