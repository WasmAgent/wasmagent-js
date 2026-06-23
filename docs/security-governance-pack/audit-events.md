# Audit Events

WasmAgent emits a structured, typed event for every significant action during
an agent run. Every event is persisted to KV, resumable via SSE
`Last-Event-ID`, and exportable to OpenTelemetry.

---

## Event catalogue

All events share a common base:

```ts
{
  traceId: string;        // unique ID for this agent run branch
  parentTraceId: string | null;  // parent agent's traceId (multi-agent fan-out)
  timestampMs: number;   // Unix timestamp in milliseconds
  event: string;         // discriminant — see table below
  channel: string;       // routing hint for UIs ("text" | "thinking" | "tool" | "model" | "status" | "action" | "artifact")
  data: { … };           // event-specific payload
}
```

| `event` | `channel` | When emitted | Key `data` fields |
|---|---|---|---|
| `run_start` | `text` | Agent run begins | `task`, `agentConfig` (model, tools, maxSteps) |
| `step_start` | `thinking` | Each reasoning step begins | `step` |
| `thinking_delta` | `thinking` | Streaming chain-of-thought tokens | `delta`, `step` |
| `planning` | `thinking` | Planner emits plan + facts | `step`, `plan`, `facts` |
| `model_start` | `model` | Before each `model.generate()` call | `modelId`, `step` |
| `model_done` | `model` | After model stream ends | `modelId`, `step`, `finishReason`, `inputTokens`, `outputTokens`, `thinkingTokens`, `cacheReadTokens`, `cacheHitRate`, `estimatedUsd`, `calls` |
| `tool_call` | `tool` | Before a tool executes | `toolName`, `args`, `callId`, `batchId`, `batchSize`, `stepIndex` |
| `tool_result` | `tool` | After a tool completes | `callId`, `toolName`, `output`, `error?`, `batchId`, `stepIndex` |
| `tool_fallback_offered` | `tool` | A tool failed and alternatives exist | `failedTool`, `error`, `candidates`, `stepIndex` |
| `tool_synthesised` | `tool` | Agent uses code-execution as a tool synthesis substrate | `codeToolName`, `callId`, `stepIndex` |
| `action_proposed` | `action` | Agent decides to take an action | `actionId`, `type`, `path?`, `reason?` |
| `action_executing` | `action` | Action execution starts | `actionId`, `startedAtMs` |
| `action_completed` | `action` | Action finishes | `actionId`, `durationMs`, `success`, `error?` |
| `await_human_input` | `status` | HITL approval gate triggered | `promptId`, `prompt`, `step` |
| `guardrail_tripwire` | `status` | A guardrail fired and blocked the agent | `guardrailName`, `layer` (input/output/tool), `toolName?`, `metadata?` |
| `goal_adaptation_proposed` | `status` | GoalDirectedAgent proposes relaxing criteria | `keepCriteria`, `relaxCriteria`, `droppedCriteria`, `iterationCount` |
| `handoff` | `status` | Control transferred to another agent | `targetAgentName`, `step` |
| `supervisor_decision` | `status` | Supervisor aborts or restarts the run | `action` (abort/restart), `reason?`, `runCount` |
| `error_recovery` | `status` | Agent classifies an error and chooses a recovery strategy | `strategy`, `errorType`, `attempt`, `maxAttempts`, `fixHint?` |
| `status` | `status` | Tool execution phase marker | `phase`, `toolName?`, `callId?`, `step` |
| `final_answer` | `text` | Agent produces its final answer | `answer` |
| `error` | `text` | Agent terminates with an error | `error`, `step?` |
| `artifact_stream_start` | `artifact` | Streaming file/component begins | `artifactId`, `type`, `path?`, `label?` |
| `artifact_delta` | `artifact` | Incremental artifact chunk | `artifactId`, `delta`, `offset?` |
| `artifact_stream_end` | `artifact` | Artifact fully received | `artifactId`, `contentHash`, `totalBytes` |

---

## KV storage format

Events are stored under the key pattern:

```
evlog:<traceId>:<paddedSeq>
```

- `traceId` — the agent run's unique identifier (UUID).
- `paddedSeq` — 12-digit zero-padded integer (lexicographic sort = monotonic
  sort). This guarantees correct ordering with `kv.list(prefix)`.
- Value — JSON-serialised `AgentEvent` object.

Example key: `evlog:a3b1c2d4-0000-0000-0000-000000000001:000000000042`

Use `kv.list("evlog:<traceId>:")` to enumerate all events for a run in order.

---

## Querying events

### From TypeScript (server-side)

```ts
import { EventLog } from "@wasmagent/core";
import { myKvBackend } from "./kv";

const log = new EventLog(myKvBackend);

// Replay all events for a run:
for await (const { eventId, event } of log.replay(traceId)) {
  console.log(eventId, event.event, event.data);
}

// Replay only events after a known ID (SSE resume):
const lastSeen = req.headers.get("Last-Event-ID");
for await (const { eventId, event } of log.replay(traceId, lastSeen)) {
  await sseWriter.write(formatSseFrame({ eventId, event }));
}

// High-water mark (last seen event ID for a trace):
const hwm = await log.highWaterMark(traceId);

// Clean up after a completed run:
await log.purge(traceId);
```

### From the CLI (wrangler KV)

```bash
# List all event keys for a trace
wrangler kv key list --binding=CHECKPOINTS_KV --prefix="evlog:<traceId>:"

# Read a specific event
wrangler kv key get --binding=CHECKPOINTS_KV "evlog:<traceId>:000000000042"
```

---

## Tapping events during a live run

```ts
import { EventLog, formatSseFrame } from "@wasmagent/core";

const log = new EventLog(kvBackend);

// agent.run() returns AsyncGenerator<AgentEvent>
for await (const logged of log.tap(agent.run(task), traceId)) {
  // logged.eventId — the assigned monotonic ID
  // logged.event   — the original AgentEvent
  await sseWriter.write(formatSseFrame(logged));
}
```

---

## OpenTelemetry export

Map `AgentEvent` types to OTel GenAI semantic convention spans:

| `event` | OTel mapping |
|---|---|
| `model_start` | Start `gen_ai.chat` span; set `gen_ai.system`, `gen_ai.request.model` |
| `model_done` | End `gen_ai.chat` span; set `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons` |
| `tool_call` | Start `gen_ai.tool` child span; set `gen_ai.tool.name`, `gen_ai.tool.call.id` |
| `tool_result` | End `gen_ai.tool` span; set `error.type` if `error` is present |
| `guardrail_tripwire` | Emit as a span event on the enclosing `gen_ai.chat` span; set `guardrail.name`, `guardrail.layer` |
| `run_start` | Start top-level `gen_ai.agent` span; set `gen_ai.agent.name`, `gen_ai.request.model` |
| `final_answer` / `error` | End top-level `gen_ai.agent` span |

Example OTel bridge (minimal):

```ts
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("wasmagent");

for await (const { eventId, event } of log.tap(agent.run(task), traceId)) {
  if (event.event === "model_start") {
    const span = tracer.startSpan("gen_ai.chat", {
      attributes: { "gen_ai.request.model": event.data.modelId },
    });
    activeSpans.set(event.traceId, span);
  } else if (event.event === "model_done") {
    const span = activeSpans.get(event.traceId);
    span?.setAttributes({
      "gen_ai.usage.input_tokens": event.data.inputTokens ?? 0,
      "gen_ai.usage.output_tokens": event.data.outputTokens ?? 0,
    });
    span?.end();
  }
  // … handle other events
}
```

---

## Retention and redaction

- **Retention:** call `log.purge(traceId)` after a completed run to delete all
  events. The `EventLog` does not auto-expire entries — set a TTL on the KV
  namespace or run a periodic cleanup job.
- **Redaction:** the `EventLog` does not redact event payloads automatically.
  Wire a `redactPostHook` to strip sensitive content from tool outputs before
  they are emitted as `tool_result` events. For compliance deployments, filter
  `data.answer` in `final_answer` events before persisting to KV.
- **Access control:** the KV namespace (`CHECKPOINTS_KV`) should be accessible
  only to the worker's service binding. Do not expose the namespace directly
  to external clients.

---

*See also: [`packages/core/src/streaming/EventLog.ts`](../../packages/core/src/streaming/EventLog.ts),
[`packages/core/src/types/events.ts`](../../packages/core/src/types/events.ts).*
