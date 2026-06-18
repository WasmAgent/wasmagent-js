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
  | (AgentEventBase & { channel: "text"; event: "run_start"; data: { task: string } })
  | (AgentEventBase & { channel: "thinking"; event: "step_start"; data: { step: number } })
  | (AgentEventBase & {
      channel: "thinking";
      event: "thinking_delta";
      data: { delta: string; step: number };
    })
  | (AgentEventBase & {
      channel: "tool";
      event: "tool_call";
      data: {
        toolName: string;
        args: Record<string, unknown>;
        callId: string;
        batchId: string;
        batchSize: number;
        stepIndex: number;
      };
    })
  | (AgentEventBase & {
      channel: "tool";
      event: "tool_result";
      data: {
        callId: string;
        toolName: string;
        output: unknown;
        error?: { code: "execution_error"; message: string };
        batchId: string;
        batchSize: number;
        stepIndex: number;
      };
    })
  | (AgentEventBase & {
      channel: "tool";
      event: "tool_fallback_offered";
      // 2026-06-18 (axis 9, L1) — surfaced when a tool fails AND its
      // ToolDefinition.alternatives names at least one tool registered
      // in the same ToolRegistry. The framework caps the candidate
      // list at 3 per failure.
      data: {
        failedTool: string;
        error: string;
        candidates: { name: string; description: string }[];
        stepIndex: number;
      };
    })
  | (AgentEventBase & {
      channel: "tool";
      event: "tool_synthesised";
      // 2026-06-18 (axis 9, L2) — emitted when the agent calls the
      // tool nominated as synthesis substrate (default "execute_code")
      // AND enableToolSynthesis is on. Discriminates "synthesis on
      // failure" from a routine code-mode call. The framework does
      // not classify intent — that's left to observers reading the
      // call args. `codeToolName` echoes which tool was treated as
      // substrate so multi-tool environments can disambiguate.
      data: {
        codeToolName: string;
        callId: string;
        stepIndex: number;
      };
    })
  | (AgentEventBase & {
      channel: "status";
      event: "goal_adaptation_proposed";
      // 2026-06-18 (axis 9, L3) — emitted when GoalDirectedAgent has
      // exhausted iterations with `allowNegotiate: true` and the synth
      // model has proposed a modified criteria set. The caller's
      // `onAdaptationProposed` callback (or the CLI's stdin prompt)
      // resolves to accept / reject / edit. On accept the loop
      // resumes with the new criteria; reject/timeout terminates
      // with outcome `"negotiation-proposed"`.
      data: {
        keepCriteria: unknown[];
        relaxCriteria: { original: unknown; proposed: unknown; reasoning: string }[];
        droppedCriteria: { original: unknown; reasoning: string }[];
        iterationCount: number;
      };
    })
  | (AgentEventBase & {
      channel: "thinking";
      event: "planning";
      data: { step: number; plan: string; facts: string };
    })
  | (AgentEventBase & { channel: "text"; event: "final_answer"; data: { answer: unknown } })
  | (AgentEventBase & { channel: "text"; event: "error"; data: { error: string; step?: number } })
  | (AgentEventBase & {
      channel: "status";
      event: "status";
      data: { phase: "tool_executing"; toolName?: string; callId?: string; step: number };
    })
  /** B4: human-in-the-loop pause point. Agent is suspended until humanResponse is provided. */
  | (AgentEventBase & {
      channel: "status";
      event: "await_human_input";
      data: { promptId: string; prompt: string; step: number };
    })
  /**
   * E1: model inference span markers for GenAI semconv.
   * model_start — emitted before each model.generate() call; opens the 'chat' inference span.
   * model_done  — emitted after the stream ends; closes it with finish reason and token usage.
   */
  | (AgentEventBase & {
      channel: "model";
      event: "model_start";
      data: { modelId: string; step: number };
    })
  | (AgentEventBase & {
      channel: "model";
      event: "model_done";
      data: {
        modelId: string;
        step: number;
        finishReason: string;
        inputTokens?: number;
        outputTokens?: number;
        thinkingTokens?: number;
        cacheReadTokens?: number;
        /** Derived: cacheReadTokens / (inputTokens + cacheReadTokens) */
        cacheHitRate?: number;
        /** Derived: estimated USD cost at default Sonnet 4.x pricing */
        estimatedUsd?: number;
        /** Total model calls in this run so far */
        calls?: number;
      };
    })
  /**
   * A1: guardrail tripwire triggered — emitted when an input/output/tool guardrail
   * fires fail-fast before the agent can produce or emit its answer.
   */
  | (AgentEventBase & {
      channel: "status";
      event: "guardrail_tripwire";
      data: {
        guardrailName: string;
        layer: "input" | "output" | "tool";
        toolName?: string;
        metadata?: Record<string, unknown>;
      };
    })
  /**
   * B2: handoff — control has been transferred to another agent.
   */
  | (AgentEventBase & {
      channel: "status";
      event: "handoff";
      data: { targetAgentName: string; step: number };
    })
  /**
   * F1: Streaming artifact events — bolt.diy / v0.dev pattern.
   * Emitted as the agent streams structured file content incrementally,
   * enabling progressive rendering in the frontend before generation completes.
   *
   * artifact_stream_start: opens a new artifact (file/component) being streamed.
   * artifact_delta: incremental content chunk for a streaming artifact.
   * artifact_stream_end: artifact fully received; includes content hash.
   */
  | (AgentEventBase & {
      channel: "artifact";
      event: "artifact_stream_start";
      data: {
        artifactId: string;
        type: "file" | "component" | "code";
        /** File path for "file" artifacts */
        path?: string;
        /** Human-readable label for display */
        label?: string;
      };
    })
  | (AgentEventBase & {
      channel: "artifact";
      event: "artifact_delta";
      data: {
        artifactId: string;
        /** Incremental content chunk */
        delta: string;
        /** Cumulative byte offset (for ordering/dedup) */
        offset?: number;
      };
    })
  | (AgentEventBase & {
      channel: "artifact";
      event: "artifact_stream_end";
      data: {
        artifactId: string;
        /** SHA-256 of final content (first 16 hex chars) for cache/dedup */
        contentHash: string;
        /** Total bytes received */
        totalBytes: number;
      };
    })
  /**
   * F2: Action lifecycle events — enable fine-grained observability (Vercel AI SDK pattern).
   * Emitted around tool execution for tracing dashboards and frontend progress indicators.
   *
   * action_proposed: agent has decided to take an action (before execution).
   * action_executing: action has started executing.
   * action_completed: action finished (success or error).
   */
  | (AgentEventBase & {
      channel: "action";
      event: "action_proposed";
      data: {
        actionId: string;
        /** Tool name or action type */
        type: string;
        /** File path for file-write actions */
        path?: string;
        /** Brief rationale extracted from model's explanation */
        reason?: string;
      };
    })
  | (AgentEventBase & {
      channel: "action";
      event: "action_executing";
      data: { actionId: string; startedAtMs: number };
    })
  | (AgentEventBase & {
      channel: "action";
      event: "action_completed";
      data: {
        actionId: string;
        durationMs: number;
        /** Whether the action succeeded */
        success: boolean;
        /** Error message if failed */
        error?: string;
      };
    })
  /**
   * F3: Error recovery events — GPT-Engineer improve_loop pattern.
   * Emitted when the agent classifies an error and decides on a recovery strategy.
   */
  | (AgentEventBase & {
      channel: "status";
      event: "error_recovery";
      data: {
        strategy: "retry" | "backoff" | "fail_fast";
        errorType: string;
        attempt: number;
        maxAttempts: number;
        fixHint?: string;
      };
    });

/** Structured step types mirroring smolagents' ActionStep / PlanningStep / FinalAnswerStep. */
export type StepType =
  | "action"
  | "planning"
  | "final_answer"
  | "tool_use"
  | "parallel_tool_use"
  | "user_message";

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
  /** True when the tool output is from an untrusted external source (B1 injection defense). */
  isUntrusted?: boolean;
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
  /** True when the tool output is from an untrusted external source (B1 injection defense). */
  isUntrusted?: boolean;
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

export type Step =
  | ActionStep
  | PlanningStep
  | FinalAnswerStep
  | ToolUseStep
  | ParallelToolUseStep
  | UserMessageStep;
