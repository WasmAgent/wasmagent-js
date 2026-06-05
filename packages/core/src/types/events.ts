/**
 * Agent streaming event — carries full tracing context for multi-agent fan-out (C1/C2).
 *
 * Every event emitted by an agent run must carry these fields so the host
 * (or a frontend) can split streams per-branch and reconstruct the parent→child tree.
 */
export interface AgentEvent {
  /** Unique identifier for this agent's execution branch (e.g. "main", "main.sub1"). */
  traceId: string;
  /** Parent agent's traceId, or null for the root agent. */
  parentTraceId: string | null;
  /** Output channel this event belongs to. */
  channel: "thinking" | "text" | "tool";
  /** Semantic event type. */
  event:
    | "run_start"
    | "step_start"
    | "tool_call"
    | "tool_result"
    | "planning"
    | "final_answer"
    | "error";
  data: unknown;
  timestampMs: number;
}

/** Structured step types mirroring smolagents' ActionStep / PlanningStep / FinalAnswerStep. */
export type StepType = "action" | "planning" | "final_answer";

export interface ActionStep {
  type: "action";
  stepIndex: number;
  thoughts: string;
  code: string;
  observations: string;
}

export interface PlanningStep {
  type: "planning";
  plan: string;
  facts: string;
}

export interface FinalAnswerStep {
  type: "final_answer";
  answer: unknown;
}

export type Step = ActionStep | PlanningStep | FinalAnswerStep;
