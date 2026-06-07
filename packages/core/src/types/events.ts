/**
 * Agent streaming event — carries full tracing context for multi-agent fan-out (C1/C2).
 *
 * Every event emitted by an agent run must carry these fields so the host
 * (or a frontend) can split streams per-branch and reconstruct the parent→child tree.
 *
 * AgentEvent is a discriminated union on the `event` field. TypeScript narrows
 * `data` automatically based on which `event` variant is matched — no unsafe casts needed.
 */

interface AgentEventBase {
  /** Unique identifier for this agent's execution branch. */
  traceId: string;
  /** Parent agent's traceId, or null for the root agent. */
  parentTraceId: string | null;
  timestampMs: number;
}

export type AgentEvent =
  | AgentEventBase & { channel: "text";     event: "run_start";       data: { task: string } }
  | AgentEventBase & { channel: "thinking"; event: "step_start";      data: { step: number } }
  | AgentEventBase & { channel: "thinking"; event: "thinking_delta";  data: { delta: string; step: number } }
  | AgentEventBase & { channel: "tool";     event: "tool_call";       data: { toolName: string; args: Record<string, unknown>; callId: string; batchId: string; batchSize: number; stepIndex: number } }
  | AgentEventBase & { channel: "tool";     event: "tool_result";     data: { callId: string; toolName: string; output: unknown; error?: { code: "execution_error"; message: string }; batchId: string; batchSize: number; stepIndex: number } }
  | AgentEventBase & { channel: "thinking"; event: "planning";        data: { step: number; plan: string; facts: string } }
  | AgentEventBase & { channel: "text";     event: "final_answer";    data: { answer: unknown } }
  | AgentEventBase & { channel: "text";     event: "error";           data: { error: string; step?: number } }
  | AgentEventBase & { channel: "status";   event: "status";          data: { phase: "tool_executing"; toolName?: string; callId?: string; step: number } };

/** Structured step types mirroring smolagents' ActionStep / PlanningStep / FinalAnswerStep. */
export type StepType = "action" | "planning" | "final_answer" | "tool_use" | "parallel_tool_use" | "user_message";

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

/**
 * ToolUseStep — represents a single tool invocation in ToolCallingAgent history.
 *
 * Encodes the assistant's tool_use block and the user's tool_result block as a
 * structured pair so MessageAssembler can produce the correct multi-turn conversation
 * format required by the Anthropic and OpenAI tool_use APIs.
 */
export interface ToolUseStep {
  type: "tool_use";
  stepIndex: number;
  /** Model thoughts / text before the tool call (may be empty). */
  thoughts: string;
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: string;
  /** True when the tool returned an error instead of a result. */
  isError: boolean;
}

/**
 * ParallelToolUseStep — represents a batch of tool invocations dispatched in parallel.
 *
 * Encodes one assistant message (with N tool_use blocks) and one user message
 * (with N tool_result blocks in matching order), as required by the Anthropic and
 * OpenAI multi-turn tool APIs when multiple tools are called in a single step.
 */
export interface ParallelToolUseCall {
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: string;
  isError: boolean;
}

export interface ParallelToolUseStep {
  type: "parallel_tool_use";
  stepIndex: number;
  /** Model thoughts / text before the tool calls (may be empty). */
  thoughts: string;
  calls: ParallelToolUseCall[];
}

/**
 * UserMessageStep — injects a plain user text message into conversation history.
 *
 * Used by ToolCallingAgent to seed the conversation with the task text directly
 * as a user turn, without the ActionStep assistant+user wrapper overhead.
 */
export interface UserMessageStep {
  type: "user_message";
  content: string;
}

export type Step = ActionStep | PlanningStep | FinalAnswerStep | ToolUseStep | ParallelToolUseStep | UserMessageStep;
