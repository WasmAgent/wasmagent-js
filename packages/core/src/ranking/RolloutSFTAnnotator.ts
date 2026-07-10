import type { AgentEvent } from "../types/events.js";
import type { RankedBranch } from "./RolloutRanker.js";

export interface TurnAnnotation {
  turnIndex: number;
  lossWeightTokens: "default" | "recovery" | "state_summary" | "high_value";
}

/**
 * Annotate turns in a trajectory using observable signals only.
 *
 * Rules (applied in priority order):
 *  "recovery" — assistant turn immediately after a tool result with error
 *  "state_summary" — assistant turn with non-empty content before next tool_calls
 *  "high_value" — assistant turn after which the branch's running score
 *                 improved by >= threshold vs the branch mean
 *  "default" — everything else
 */
export class RolloutSFTAnnotator {
  annotate(
    trajectory: AgentEvent[],
    rankedBranch: RankedBranch,
    opts?: { highValueThreshold?: number }
  ): TurnAnnotation[] {
    const threshold = opts?.highValueThreshold ?? 0.15;
    const annotations: TurnAnnotation[] = [];

    for (let i = 0; i < trajectory.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: index bounds checked by loop
      const event = trajectory[i]!
      if (!isAssistantTurn(event)) continue;

      const prevEvent = i > 0 ? trajectory[i - 1] : undefined;
      const nextEvent = i < trajectory.length - 1 ? trajectory[i + 1] : undefined;

      // Rule 1: recovery — previous event is tool_result with error
      if (prevEvent && isErrorToolResult(prevEvent)) {
        annotations.push({ turnIndex: i, lossWeightTokens: "recovery" });
        continue;
      }

      // Rule 2: state_summary — assistant has content and next event is tool_call
      if (hasContent(event) && nextEvent && isToolCall(nextEvent)) {
        annotations.push({ turnIndex: i, lossWeightTokens: "state_summary" });
        continue;
      }

      // Rule 3: high_value — branch objective passed and totalScore exceeds threshold + 0.5
      // (i.e. score improved by >= threshold vs a baseline mean of 0.5), and the next
      // event is a successful tool_result.
      if (
        rankedBranch.objectiveScore === 1 &&
        rankedBranch.totalScore >= threshold + 0.5 &&
        nextEvent &&
        isSuccessfulToolResult(nextEvent)
      ) {
        annotations.push({ turnIndex: i, lossWeightTokens: "high_value" });
        continue;
      }

      annotations.push({ turnIndex: i, lossWeightTokens: "default" });
    }

    return annotations;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isAssistantTurn(event: AgentEvent): boolean {
  return event.event === "model_done" || event.event === "final_answer";
}

function isErrorToolResult(event: AgentEvent): boolean {
  if (event.event !== "tool_result") return false;
  return event.data.error !== undefined;
}

function isToolCall(event: AgentEvent): boolean {
  return event.event === "tool_call";
}

function hasContent(event: AgentEvent): boolean {
  if (event.event === "final_answer") {
    return Boolean(event.data.answer);
  }
  if (event.event === "model_done") {
    // model_done always signals content was generated
    return true;
  }
  return false;
}

function isSuccessfulToolResult(event: AgentEvent): boolean {
  if (event.event !== "tool_result") return false;
  return event.data.error === undefined;
}
