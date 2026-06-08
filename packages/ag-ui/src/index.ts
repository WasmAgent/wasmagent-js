/**
 * AG-UI protocol adapter for @agentkit-js/core.
 *
 * Maps the private AgentEvent stream to the AG-UI 16-class event protocol
 * (docs.ag-ui.com), enabling any AG-UI-compatible frontend (CopilotKit,
 * LangGraph Studio, AWS Bedrock AgentCore, etc.) to consume agentkit runs.
 *
 * Usage:
 *   import { toAgUiEvents } from "@agentkit-js/ag-ui";
 *   for await (const agUiEvent of toAgUiEvents(agent.run("task"))) {
 *     // agUiEvent conforms to the AG-UI event schema
 *   }
 *
 * AG-UI event mapping:
 *   run_start          → RUN_STARTED
 *   step_start         → (suppressed — internal detail)
 *   thinking_delta     → TEXT_MESSAGE_CHUNK (thinking channel)
 *   tool_call          → TOOL_CALL_START
 *   tool_result        → TOOL_CALL_END
 *   planning           → TEXT_MESSAGE_CHUNK (planning)
 *   final_answer       → TEXT_MESSAGE_CONTENT + RUN_FINISHED
 *   error              → RUN_ERROR
 *   await_human_input  → STEP_FINISHED (with pending approval metadata)
 *   guardrail_tripwire → RUN_ERROR (tripwire)
 *   model_start        → (suppressed — internal span marker)
 *   model_done         → (suppressed — internal span marker)
 *
 * Content-type negotiation:
 *   The cloudflare-worker /run endpoint should check Accept header for
 *   "application/vnd.ag-ui+sse" and pipe through toAgUiEvents() when present.
 */

import type { AgentEvent } from "@agentkit-js/core";

// ── AG-UI event types ─────────────────────────────────────────────────────────

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
  | "TOOL_CALL_ARGS_DELTA"
  | "TOOL_CALL_END"
  | "STATE_SNAPSHOT"
  | "STATE_DELTA"
  | "MESSAGES_SNAPSHOT"
  | "RAW";

export interface AgUiBaseEvent {
  type: AgUiEventType;
  /** Run identifier (maps to agentkit traceId). */
  runId: string;
  timestampMs: number;
}

export type AgUiEvent =
  | AgUiBaseEvent & { type: "RUN_STARTED"; data: { task: string } }
  | AgUiBaseEvent & { type: "RUN_FINISHED"; data: { answer: unknown } }
  | AgUiBaseEvent & { type: "RUN_ERROR"; data: { message: string; layer?: "input" | "output" | "tool"; guardrailName?: string } }
  | AgUiBaseEvent & { type: "STEP_STARTED"; data: { step: number } }
  | AgUiBaseEvent & { type: "STEP_FINISHED"; data: { step: number } }
  | AgUiBaseEvent & { type: "TEXT_MESSAGE_START"; data: { messageId: string; role: "assistant" } }
  | AgUiBaseEvent & { type: "TEXT_MESSAGE_CONTENT"; data: { messageId: string; delta: string } }
  | AgUiBaseEvent & { type: "TEXT_MESSAGE_CHUNK"; data: { messageId: string; delta: string; channel?: string } }
  | AgUiBaseEvent & { type: "TEXT_MESSAGE_END"; data: { messageId: string } }
  | AgUiBaseEvent & { type: "TOOL_CALL_START"; data: { toolCallId: string; toolName: string; args: Record<string, unknown>; batchId: string; batchSize: number; stepIndex: number } }
  | AgUiBaseEvent & { type: "TOOL_CALL_END"; data: { toolCallId: string; toolName: string; output: unknown; isError: boolean } }
  | AgUiBaseEvent & { type: "STATE_SNAPSHOT"; data: { snapshot: unknown } }
  | AgUiBaseEvent & { type: "STATE_DELTA"; data: { delta: unknown } }
  | AgUiBaseEvent & { type: "MESSAGES_SNAPSHOT"; data: { messages: unknown[] } }
  | AgUiBaseEvent & { type: "RAW"; data: { event: AgentEvent } };

// ── Main adapter ──────────────────────────────────────────────────────────────

/**
 * Transform an agentkit AgentEvent async iterable into an AG-UI event stream.
 *
 * Passes through all events from the source; some private agentkit events
 * are suppressed (step_start, model_start, model_done) or mapped to richer
 * AG-UI equivalents.
 *
 * @param source - async iterable of AgentEvent (e.g. agent.run(...))
 */
export async function* toAgUiEvents(
  source: AsyncIterable<AgentEvent>
): AsyncGenerator<AgUiEvent> {
  for await (const ev of source) {
    const runId = ev.traceId;
    const ts = ev.timestampMs;

    switch (ev.event) {
      case "run_start":
        yield { type: "RUN_STARTED", runId, timestampMs: ts, data: { task: ev.data.task } };
        break;

      case "step_start":
        yield { type: "STEP_STARTED", runId, timestampMs: ts, data: { step: ev.data.step } };
        break;

      case "thinking_delta":
        yield {
          type: "TEXT_MESSAGE_CHUNK",
          runId,
          timestampMs: ts,
          data: { messageId: `thinking-${runId}-${ev.data.step}`, delta: ev.data.delta, channel: "thinking" },
        };
        break;

      case "planning":
        yield {
          type: "TEXT_MESSAGE_CHUNK",
          runId,
          timestampMs: ts,
          data: { messageId: `planning-${runId}-${ev.data.step}`, delta: ev.data.plan, channel: "planning" },
        };
        break;

      case "tool_call":
        yield {
          type: "TOOL_CALL_START",
          runId,
          timestampMs: ts,
          data: {
            toolCallId: ev.data.callId,
            toolName: ev.data.toolName,
            args: ev.data.args,
            batchId: ev.data.batchId,
            batchSize: ev.data.batchSize,
            stepIndex: ev.data.stepIndex,
          },
        };
        break;

      case "tool_result": {
        const isError = !!ev.data.error;
        yield {
          type: "TOOL_CALL_END",
          runId,
          timestampMs: ts,
          data: {
            toolCallId: ev.data.callId,
            toolName: ev.data.toolName,
            output: isError ? ev.data.error : ev.data.output,
            isError,
          },
        };
        break;
      }

      case "final_answer": {
        const answerStr = typeof ev.data.answer === "string"
          ? ev.data.answer
          : JSON.stringify(ev.data.answer ?? null);
        const msgId = `answer-${runId}`;
        yield { type: "TEXT_MESSAGE_START", runId, timestampMs: ts, data: { messageId: msgId, role: "assistant" } };
        yield { type: "TEXT_MESSAGE_CONTENT", runId, timestampMs: ts, data: { messageId: msgId, delta: answerStr } };
        yield { type: "TEXT_MESSAGE_END", runId, timestampMs: ts, data: { messageId: msgId } };
        yield { type: "RUN_FINISHED", runId, timestampMs: ts, data: { answer: ev.data.answer } };
        break;
      }

      case "error":
        yield {
          type: "RUN_ERROR",
          runId,
          timestampMs: ts,
          data: { message: ev.data.error },
        };
        break;

      case "await_human_input":
        // Pause point — emit as STEP_FINISHED with approval metadata embedded in STATE_DELTA.
        yield {
          type: "STATE_DELTA",
          runId,
          timestampMs: ts,
          data: { delta: { pendingApproval: { promptId: ev.data.promptId, prompt: ev.data.prompt } } },
        };
        yield {
          type: "STEP_FINISHED",
          runId,
          timestampMs: ts,
          data: { step: ev.data.step },
        };
        break;

      case "guardrail_tripwire": {
        const d = ev.data as { guardrailName: string; layer: "input" | "output" | "tool"; toolName?: string; metadata?: Record<string, unknown> };
        yield {
          type: "RUN_ERROR",
          runId,
          timestampMs: ts,
          data: {
            message: `Guardrail "${d.guardrailName}" triggered (layer: ${d.layer})`,
            layer: d.layer,
            guardrailName: d.guardrailName,
          },
        };
        break;
      }

      case "status":
        // Internal status events are not forwarded in AG-UI; they are absorbed.
        break;

      case "model_start":
      case "model_done":
        // Internal span markers — not part of the AG-UI surface.
        break;

      default:
        // Pass unknown events through as RAW for forward-compatibility.
        yield { type: "RAW", runId, timestampMs: ts, data: { event: ev } };
        break;
    }
  }
}

// ── SSE serialization helper ───────────────────────────────────────────────────

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
 */
export function toAgUiSseStream(source: AsyncIterable<AgentEvent>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of toAgUiEvents(source)) {
          controller.enqueue(encoder.encode(toSseString(ev)));
        }
      } finally {
        controller.close();
      }
    },
  });
}
