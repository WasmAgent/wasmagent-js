/**
 * AG-UI protocol adapter for @agentkit-js/core.
 *
 * Maps the private AgentEvent stream to the AG-UI 16-class event protocol
 * (docs.ag-ui.com), enabling any AG-UI-compatible frontend (CopilotKit,
 * LangGraph Studio, AWS Bedrock AgentCore, etc.) to consume agentkit runs.
 *
 * AG1: Uses official field names (timestamp not timestampMs) and event classes.
 * AG2: Implements fromRunAgentInput() for bidirectional protocol support.
 * AG3: toAgUiSseStream() is ready for cloudflare-worker content negotiation.
 *
 * AG-UI event mapping:
 *   run_start          → RUN_STARTED
 *   step_start         → STEP_STARTED
 *   thinking_delta     → TEXT_MESSAGE_CHUNK (thinking channel)
 *   tool_call          → TOOL_CALL_START + TOOL_CALL_ARGS
 *   tool_result        → TOOL_CALL_RESULT + TOOL_CALL_END
 *   planning           → TEXT_MESSAGE_CHUNK (planning)
 *   final_answer       → TEXT_MESSAGE_START + TEXT_MESSAGE_CONTENT + TEXT_MESSAGE_END + RUN_FINISHED
 *   error              → RUN_ERROR
 *   await_human_input  → STATE_DELTA (pendingApproval) + STEP_FINISHED
 *   guardrail_tripwire → RUN_ERROR (tripwire)
 *
 * Content-type negotiation:
 *   The cloudflare-worker /run endpoint checks Accept header for
 *   "text/event-stream" or "application/vnd.ag-ui+sse" and pipes through
 *   toAgUiSseStream() when present, while also accepting RunAgentInput bodies.
 */

import type { AgentEvent, ModelMessage } from "@agentkit-js/core";

// ── AG-UI official event types (aligned with ag-ui-protocol 2026-04) ──────────

export type AgUiEventType =
  | "RUN_STARTED"
  | "RUN_FINISHED"
  | "RUN_ERROR"
  | "STEP_STARTED"
  | "STEP_FINISHED"
  | "TEXT_MESSAGE_START"
  | "TEXT_MESSAGE_CONTENT"
  | "TEXT_MESSAGE_CHUNK"
  | "TEXT_MESSAGE_END"
  | "TOOL_CALL_START"
  | "TOOL_CALL_ARGS"
  | "TOOL_CALL_RESULT"
  | "TOOL_CALL_END"
  | "STATE_SNAPSHOT"
  | "STATE_DELTA"
  | "MESSAGES_SNAPSHOT"
  | "INTERRUPT"
  | "RAW";

export interface AgUiBaseEvent {
  type: AgUiEventType;
  /** Run identifier (maps to agentkit traceId). */
  runId: string;
  /** Official AG-UI field name: timestamp (Unix ms). */
  timestamp: number;
}

export type AgUiEvent =
  | (AgUiBaseEvent & { type: "RUN_STARTED"; data: { task: string } })
  | (AgUiBaseEvent & { type: "RUN_FINISHED"; data: { answer: unknown } })
  | (AgUiBaseEvent & {
      type: "RUN_ERROR";
      data: {
        message: string;
        code?: string;
        layer?: "input" | "output" | "tool";
        guardrailName?: string;
      };
    })
  | (AgUiBaseEvent & { type: "STEP_STARTED"; data: { step: number } })
  | (AgUiBaseEvent & { type: "STEP_FINISHED"; data: { step: number } })
  | (AgUiBaseEvent & { type: "TEXT_MESSAGE_START"; data: { messageId: string; role: "assistant" } })
  | (AgUiBaseEvent & { type: "TEXT_MESSAGE_CONTENT"; data: { messageId: string; delta: string } })
  | (AgUiBaseEvent & {
      type: "TEXT_MESSAGE_CHUNK";
      data: { messageId: string; delta: string; channel?: string };
    })
  | (AgUiBaseEvent & { type: "TEXT_MESSAGE_END"; data: { messageId: string } })
  | (AgUiBaseEvent & {
      type: "TOOL_CALL_START";
      data: {
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
        batchId: string;
        batchSize: number;
        stepIndex: number;
      };
    })
  | (AgUiBaseEvent & { type: "TOOL_CALL_ARGS"; data: { toolCallId: string; delta: string } })
  | (AgUiBaseEvent & {
      type: "TOOL_CALL_RESULT";
      data: { toolCallId: string; toolName: string; output: unknown; isError: boolean };
    })
  | (AgUiBaseEvent & {
      type: "TOOL_CALL_END";
      data: { toolCallId: string; toolName: string; output: unknown; isError: boolean };
    })
  | (AgUiBaseEvent & { type: "STATE_SNAPSHOT"; data: { snapshot: unknown } })
  | (AgUiBaseEvent & { type: "STATE_DELTA"; data: { delta: unknown } })
  | (AgUiBaseEvent & { type: "MESSAGES_SNAPSHOT"; data: { messages: unknown[] } })
  | (AgUiBaseEvent & {
      type: "INTERRUPT";
      data: { promptId: string; prompt: string; step: number };
    })
  | (AgUiBaseEvent & { type: "RAW"; data: { event: AgentEvent } });

// ── RunAgentInput (AG2 — bidirectional protocol) ───────────────────────────────

/**
 * Official AG-UI RunAgentInput structure (AWS Bedrock AgentCore / ag-ui-protocol).
 * Represents a run request from an AG-UI-compatible frontend.
 */
export interface RunAgentInput {
  threadId?: string;
  runId?: string;
  /** Conversation history as AG-UI messages. */
  messages?: AgUiMessage[];
  /** Tool definitions available for this run. */
  tools?: AgUiToolDef[];
  /** Shared state snapshot. */
  state?: unknown;
  /** Extra props passed from the frontend. */
  forwardedProps?: Record<string, unknown>;
  /** The task/prompt to execute. */
  task?: string;
}

export interface AgUiMessage {
  id?: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface AgUiToolDef {
  name: string;
  description?: string;
  parameters?: object;
}

/**
 * AG2: Convert a RunAgentInput to the parameters expected by agent.run().
 *
 * Maps `messages` to `ModelMessage[]` and derives the task from the
 * last user message if `task` is not provided.
 */
export function fromRunAgentInput(input: RunAgentInput): {
  task: string;
  messages: ModelMessage[];
  threadId: string | undefined;
  runId: string | undefined;
  state: unknown;
} {
  const agUiMessages = input.messages ?? [];

  // Convert AG-UI messages to ModelMessage format.
  const messages: ModelMessage[] = agUiMessages
    .filter((m) => m.role !== "tool") // tool results handled separately
    .map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    }));

  // Derive task: explicit task field, or last user message content.
  let task = input.task ?? "";
  if (!task) {
    const lastUser = [...agUiMessages].reverse().find((m) => m.role === "user");
    task = lastUser?.content ?? "(no task)";
  }

  return {
    task,
    messages,
    threadId: input.threadId,
    runId: input.runId,
    state: input.state,
  };
}

// ── Main adapter ──────────────────────────────────────────────────────────────

/**
 * Transform an agentkit AgentEvent async iterable into an AG-UI event stream.
 *
 * Conforms to the official AG-UI event protocol (ag-ui-protocol 2026-04):
 * - Uses `timestamp` (not `timestampMs`)
 * - Emits TOOL_CALL_ARGS after TOOL_CALL_START
 * - Emits TOOL_CALL_RESULT after tool execution
 * - Maps await_human_input to INTERRUPT
 *
 * @param source - async iterable of AgentEvent (e.g. agent.run(...))
 * @param runId - optional override for the runId (e.g. from RunAgentInput.runId)
 */
export async function* toAgUiEvents(
  source: AsyncIterable<AgentEvent>,
  runId?: string
): AsyncGenerator<AgUiEvent> {
  for await (const ev of source) {
    const effectiveRunId = runId ?? ev.traceId;
    const ts = ev.timestampMs;

    switch (ev.event) {
      case "run_start":
        yield {
          type: "RUN_STARTED",
          runId: effectiveRunId,
          timestamp: ts,
          data: { task: ev.data.task },
        };
        break;

      case "step_start":
        yield {
          type: "STEP_STARTED",
          runId: effectiveRunId,
          timestamp: ts,
          data: { step: ev.data.step },
        };
        break;

      case "thinking_delta":
        yield {
          type: "TEXT_MESSAGE_CHUNK",
          runId: effectiveRunId,
          timestamp: ts,
          data: {
            messageId: `thinking-${effectiveRunId}-${ev.data.step}`,
            delta: ev.data.delta,
            channel: "thinking",
          },
        };
        break;

      case "planning":
        yield {
          type: "TEXT_MESSAGE_CHUNK",
          runId: effectiveRunId,
          timestamp: ts,
          data: {
            messageId: `planning-${effectiveRunId}-${ev.data.step}`,
            delta: ev.data.plan,
            channel: "planning",
          },
        };
        break;

      case "tool_call": {
        const argsJson = JSON.stringify(ev.data.args);
        yield {
          type: "TOOL_CALL_START",
          runId: effectiveRunId,
          timestamp: ts,
          data: {
            toolCallId: ev.data.callId,
            toolName: ev.data.toolName,
            args: ev.data.args,
            batchId: ev.data.batchId,
            batchSize: ev.data.batchSize,
            stepIndex: ev.data.stepIndex,
          },
        };
        // TOOL_CALL_ARGS carries the full args JSON as a delta for streaming clients.
        yield {
          type: "TOOL_CALL_ARGS",
          runId: effectiveRunId,
          timestamp: ts,
          data: { toolCallId: ev.data.callId, delta: argsJson },
        };
        break;
      }

      case "tool_result": {
        const isError = !!ev.data.error;
        const output = isError ? ev.data.error : ev.data.output;
        // TOOL_CALL_RESULT carries the result (official AG2 event).
        yield {
          type: "TOOL_CALL_RESULT",
          runId: effectiveRunId,
          timestamp: ts,
          data: {
            toolCallId: ev.data.callId,
            toolName: ev.data.toolName,
            output,
            isError,
          },
        };
        // TOOL_CALL_END for backwards-compat with clients that expect it.
        yield {
          type: "TOOL_CALL_END",
          runId: effectiveRunId,
          timestamp: ts,
          data: {
            toolCallId: ev.data.callId,
            toolName: ev.data.toolName,
            output,
            isError,
          },
        };
        break;
      }

      case "final_answer": {
        const answerStr =
          typeof ev.data.answer === "string"
            ? ev.data.answer
            : JSON.stringify(ev.data.answer ?? null);
        const msgId = `answer-${effectiveRunId}`;
        yield {
          type: "TEXT_MESSAGE_START",
          runId: effectiveRunId,
          timestamp: ts,
          data: { messageId: msgId, role: "assistant" },
        };
        yield {
          type: "TEXT_MESSAGE_CONTENT",
          runId: effectiveRunId,
          timestamp: ts,
          data: { messageId: msgId, delta: answerStr },
        };
        yield {
          type: "TEXT_MESSAGE_END",
          runId: effectiveRunId,
          timestamp: ts,
          data: { messageId: msgId },
        };
        yield {
          type: "RUN_FINISHED",
          runId: effectiveRunId,
          timestamp: ts,
          data: { answer: ev.data.answer },
        };
        break;
      }

      case "error":
        yield {
          type: "RUN_ERROR",
          runId: effectiveRunId,
          timestamp: ts,
          data: { message: ev.data.error },
        };
        break;

      case "await_human_input":
        // AG4: Map to official INTERRUPT event for HITL support.
        yield {
          type: "INTERRUPT",
          runId: effectiveRunId,
          timestamp: ts,
          data: { promptId: ev.data.promptId, prompt: ev.data.prompt, step: ev.data.step },
        };
        // STATE_DELTA for backwards-compat with clients polling state.
        yield {
          type: "STATE_DELTA",
          runId: effectiveRunId,
          timestamp: ts,
          data: {
            delta: { pendingApproval: { promptId: ev.data.promptId, prompt: ev.data.prompt } },
          },
        };
        yield {
          type: "STEP_FINISHED",
          runId: effectiveRunId,
          timestamp: ts,
          data: { step: ev.data.step },
        };
        break;

      case "guardrail_tripwire": {
        const d = ev.data as {
          guardrailName: string;
          layer: "input" | "output" | "tool";
          toolName?: string;
          metadata?: Record<string, unknown>;
        };
        yield {
          type: "RUN_ERROR",
          runId: effectiveRunId,
          timestamp: ts,
          data: {
            message: `Guardrail "${d.guardrailName}" triggered (layer: ${d.layer})`,
            code: "GUARDRAIL_TRIPWIRE",
            layer: d.layer,
            guardrailName: d.guardrailName,
          },
        };
        break;
      }

      case "status":
        // Internal status events — not forwarded in AG-UI protocol.
        break;

      case "model_start":
      case "model_done":
        // Internal span markers — not part of AG-UI surface.
        break;

      default:
        // Pass unknown events through as RAW for forward-compatibility.
        yield { type: "RAW", runId: effectiveRunId, timestamp: ts, data: { event: ev } };
        break;
    }
  }
}

// ── SSE serialization helpers ─────────────────────────────────────────────────

/**
 * Serialize an AG-UI event to SSE wire format.
 * Each event is emitted as:
 *   event: <type>\ndata: <json>\n\n
 *
 * Compatible with the EventSource API and AG-UI client SDKs.
 */
export function toSseString(ev: AgUiEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/**
 * Transform AgentEvent stream to AG-UI SSE byte stream (ReadableStream).
 * Suitable for direct use in Response bodies (cloudflare-worker, Next.js edge routes, etc.).
 *
 * @param source - AgentEvent async iterable
 * @param runId - optional override for the runId (e.g. from RunAgentInput.runId)
 */
export function toAgUiSseStream(
  source: AsyncIterable<AgentEvent>,
  runId?: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of toAgUiEvents(source, runId)) {
          controller.enqueue(encoder.encode(toSseString(ev)));
        }
      } finally {
        controller.close();
      }
    },
  });
}

/**
 * Detect whether a request wants AG-UI SSE output.
 * Returns true for Accept: text/event-stream or application/vnd.ag-ui+sse.
 */
export function wantsAgUiSse(request: { headers: { get(name: string): string | null } }): boolean {
  const accept = request.headers.get("Accept") ?? request.headers.get("accept") ?? "";
  return accept.includes("text/event-stream") || accept.includes("application/vnd.ag-ui+sse");
}
