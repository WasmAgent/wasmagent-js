/**
 * Cloudflare Workers entry point for agentkit-js.
 *
 * Exposes a simple HTTP API:
 *   OPTIONS *         → CORS preflight (204)
 *   GET  /health      → { status: "ok", version: string }
 *   POST /run         → Server-Sent Events stream of AgentEvent
 *
 * POST /run body:
 *   {
 *     task: string,
 *     agentType?: "code" | "tool-calling",
 *     maxSteps?: number,
 *     sessionId?: string   // C4: enables KV-backed result caching
 *   }
 *
 * C4 Session caching: when AGENTKIT_SESSIONS KV is bound and sessionId is provided,
 * completed agent results are stored in KV (TTL: 1 hour). Subsequent requests
 * with the same sessionId replay the cached event stream instantly.
 *
 * ── Edge Runtime Compatibility (A3 — resolved) ──────────────────────────────
 * Cloudflare Workers does NOT provide node:vm. JsKernel (node:vm-based) crashes.
 * This Worker uses QuickJSKernel with a pre-compiled WASM variant imported at
 * build time — Workers prohibits runtime WASM compilation (same restriction as
 * eval), so getQuickJS() (which fetches+compiles .wasm at runtime) would fail
 * with CompileError: WebAssembly code generation disallowed.
 *
 * Fix: import the @jitl/quickjs-wasmfile-release-sync variant as a static ES
 * module (wrangler bundles it), then inject it into QuickJSKernel via the
 * variant/variantLoader options. No runtime WASM compilation is needed.
 */

import cfVariant from "@jitl/quickjs-wasmfile-release-sync";
import type { RunAgentInput } from "@wasmagent/ag-ui";
import { fromRunAgentInput, toAgUiSseStream, wantsAgUiSse } from "@wasmagent/ag-ui";
import type { AgentEvent } from "@wasmagent/core";
import {
  AnthropicModel,
  AnthropicModels,
  CheckpointableRun,
  CodeAgent,
  EventLog,
  formatSseFrame,
  KvCheckpointer,
  resumeFromHuman,
  ToolCallingAgent,
} from "@wasmagent/core";
import type { QuickJSKernelOptions } from "@wasmagent/kernel-quickjs";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";

// Cloudflare Workflows engine — same WorkflowDefinition/WorkflowRunHandle
// surface as @wasmagent/core's LocalWorkflowEngine, backed by CF Workflows.
export type {
  CfStepConfig,
  CfToolCallContext,
  CfToolResolver,
  CfWorkflowBinding,
  CfWorkflowDuration,
  CfWorkflowEvent,
  CfWorkflowInstance,
  CfWorkflowStep,
  CloudflareWorkflowEngineOptions,
  RunWorkflowEntrypointOptions,
} from "./CloudflareWorkflowEngine.js";
export {
  CloudflareWorkflowEngine,
  runWorkflowEntrypoint,
} from "./CloudflareWorkflowEngine.js";
// A1 — KvBackend adapters re-exported so consumers can `import {
// CloudflareKvBackend, DurableObjectKvBackend } from
// "@wasmagent/cloudflare-worker"`.
export type {
  CloudflareKVNamespace,
  CloudflareKvBackendOptions,
  DurableObjectStorageLike,
} from "./kvAdapters.js";
export { CloudflareKvBackend, DurableObjectKvBackend } from "./kvAdapters.js";

import { CloudflareKvBackend as CloudflareKvBackendImpl } from "./kvAdapters.js";

export interface Env {
  ANTHROPIC_API_KEY: string;
  AGENTKIT_LOG_LEVEL?: string;
  /** Optional KV namespace for session result caching (C4). */
  AGENTKIT_SESSIONS?: KVNamespace;
  /**
   * Optional KV namespace for the durable SSE event log (A2).
   * When bound, every emitted event is persisted under
   * `evlog:<traceId>:<paddedId>` so a reconnecting client can resume
   * by sending `Last-Event-ID`.
   *
   * The log is independent of AGENTKIT_SESSIONS — sessions cache full
   * runs by content hash for warm replays; the event log captures the
   * partial event stream of an in-flight run for fault tolerance.
   */
  AGENTKIT_EVENT_LOG?: KVNamespace;
  /**
   * Optional KV namespace for run checkpoints (A1/A3).
   * When bound, agent state is persisted after every step and on
   * `await_human_input`, so a paused run survives worker recycle and
   * can be continued in a fresh process via POST /resume.
   */
  AGENTKIT_CHECKPOINTS?: KVNamespace;
  /**
   * Required Bearer token that POST /run and POST /resume callers must supply
   * in the Authorization header. When absent ALL requests are rejected with 401.
   * Set to a strong random secret in production; never leave unset on a public
   * deployment.
   */
  AGENTKIT_CLIENT_TOKEN?: string;
  /**
   * Comma-separated list of allowed CORS origins (e.g. "https://app.example.com").
   * Falls back to "*" when not set — restrict in production.
   */
  AGENTKIT_ALLOWED_ORIGIN?: string;
}

const SESSION_TTL_SECONDS = 3600; // 1 hour
const MAX_TASK_BYTES = 10_240; // 10 KB input cap
const MAX_STEPS_CAP = 50; // hard cap regardless of caller value
const MAX_KV_EVENTS = 500; // KV event accumulator cap (~5 MB safety margin)

function getCorsHeaders(env: Env, request: Request): Record<string, string> {
  const allowed = env.AGENTKIT_ALLOWED_ORIGIN ?? "*";
  if (allowed === "*") {
    console.warn(
      "[agentkit-worker] AGENTKIT_ALLOWED_ORIGIN is not set; CORS is open to all origins."
    );
  }
  const origin = request.headers.get("Origin") ?? "";
  const allowOrigin = allowed === "*" ? "*" : origin === allowed ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    ...(allowed !== "*" ? { Vary: "Origin" } : {}),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonError(message: string, status: number, corsHeaders: Record<string, string>): Response {
  return Response.json({ error: message }, { status, headers: corsHeaders });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const corsHeaders = getCorsHeaders(env, request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok", version: "0.1.0" }, { headers: corsHeaders });
    }

    if (url.pathname === "/run" && request.method === "POST") {
      return handleRun(request, env, ctx, corsHeaders);
    }

    if (url.pathname === "/resume" && request.method === "POST") {
      return handleResume(request, env, corsHeaders);
    }

    return jsonError("Not Found", 404, corsHeaders);
  },
} satisfies ExportedHandler<Env>;

interface RunBody {
  task: string;
  /** Which agent variant to use. Default: "code". */
  agentType?: "code" | "tool-calling";
  /** Maximum number of agent steps. Default: 10. */
  maxSteps?: number;
  /**
   * Optional session identifier for KV-backed result caching (C4).
   * If provided and AGENTKIT_SESSIONS KV is bound:
   *   - On first run: results are cached under this key for SESSION_TTL_SECONDS.
   *   - On subsequent runs with the same sessionId: cached events are replayed.
   */
  sessionId?: string;
}

function isRunBody(v: unknown): v is RunBody {
  return (
    typeof v === "object" && v !== null && "task" in v && typeof (v as RunBody).task === "string"
  );
}

function isRunAgentInput(v: unknown): v is RunAgentInput {
  return (
    typeof v === "object" &&
    v !== null &&
    // Only treat as RunAgentInput if it has AG-UI-specific fields
    // (messages array, threadId, runId, forwardedProps) but NOT legacy agentType
    ("messages" in v || "threadId" in v || "runId" in v || "forwardedProps" in v) &&
    !("agentType" in v) // legacy RunBody has agentType, AG-UI doesn't
  );
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aB = enc.encode(a);
  const bB = enc.encode(b);
  const len = Math.max(aB.length, bB.length);
  // XOR lengths first so mismatched-length inputs always return false,
  // while still running the full byte loop to avoid a timing side-channel.
  let diff = aB.length ^ bB.length;
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0);
  return diff === 0;
}

/**
 * A3 — Stateless HITL resume endpoint.
 *
 * POST /resume body: { traceId, promptId, response }
 *
 * Validates that AGENTKIT_CHECKPOINTS is bound and that a paused snapshot
 * exists for the trace, then writes the human response into the snapshot.
 * The next worker invocation that loads the trace can call
 * `restoreFromSnapshot` + `applyHumanResponse` to continue the run.
 *
 * Crucially, this endpoint holds NO long-running connection: the operator
 * can submit the response hours or days after the original pause and the
 * worker that handles the resume need not be the same one that paused.
 */
async function handleResume(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  if (!env.AGENTKIT_CLIENT_TOKEN) {
    return jsonError("Unauthorized: AGENTKIT_CLIENT_TOKEN is not configured", 401, corsHeaders);
  }
  const auth = request.headers.get("Authorization") ?? "";
  if (!timingSafeEqual(auth, `Bearer ${env.AGENTKIT_CLIENT_TOKEN}`)) {
    return jsonError("Unauthorized", 401, corsHeaders);
  }
  if (!env.AGENTKIT_CHECKPOINTS) {
    return jsonError("AGENTKIT_CHECKPOINTS KV namespace is not bound", 503, corsHeaders);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400, corsHeaders);
  }

  const b = body as Partial<{ traceId: string; promptId: string; response: string }>;
  if (
    typeof b.traceId !== "string" ||
    typeof b.promptId !== "string" ||
    typeof b.response !== "string"
  ) {
    return jsonError(
      'Body must be { "traceId": string, "promptId": string, "response": string }',
      400,
      corsHeaders
    );
  }

  const checkpointer = new KvCheckpointer(new CloudflareKvBackendImpl(env.AGENTKIT_CHECKPOINTS));
  const ok = await resumeFromHuman(checkpointer, b.traceId, b.promptId, b.response);
  if (!ok) {
    return jsonError("No paused run found for the supplied traceId/promptId", 404, corsHeaders);
  }
  return Response.json({ status: "resumed", traceId: b.traceId }, { headers: corsHeaders });
}

async function handleRun(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Auth check: always require Bearer token. The endpoint is closed by default;
  // set AGENTKIT_CLIENT_TOKEN to enable access (suitable for dev when set to a
  // known secret, or protected at the gateway layer when intentionally absent).
  if (!env.AGENTKIT_CLIENT_TOKEN) {
    return jsonError("Unauthorized: AGENTKIT_CLIENT_TOKEN is not configured", 401, corsHeaders);
  }
  const auth = request.headers.get("Authorization") ?? "";
  if (!timingSafeEqual(auth, `Bearer ${env.AGENTKIT_CLIENT_TOKEN}`)) {
    return jsonError("Unauthorized", 401, corsHeaders);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400, corsHeaders);
  }

  // AG3: Detect AG-UI SSE mode from Accept header.
  const useAgUiSse = wantsAgUiSse(request);

  // AG2: Accept both RunAgentInput (AG-UI protocol) and legacy RunBody.
  let task: string;
  let agentType: "code" | "tool-calling" = "code";
  let maxSteps = 10;
  let agUiRunId: string | undefined;

  if (isRunAgentInput(body)) {
    const parsed = fromRunAgentInput(body as RunAgentInput);
    task = parsed.task;
    agUiRunId = parsed.runId;
    // RunAgentInput defaults to tool-calling for AG-UI frontends
    agentType = "tool-calling";
  } else if (isRunBody(body)) {
    task = body.task;
    agentType = body.agentType ?? "code";
    maxSteps = body.maxSteps ?? 10;
  } else {
    return jsonError(
      'Body must include { "task": string } or a RunAgentInput object',
      400,
      corsHeaders
    );
  }

  // Input size cap to prevent DoS via oversized prompts.
  if (new TextEncoder().encode(task).byteLength > MAX_TASK_BYTES) {
    return jsonError(`task must be under ${MAX_TASK_BYTES} bytes`, 400, corsHeaders);
  }

  if (!env.ANTHROPIC_API_KEY) {
    return jsonError("ANTHROPIC_API_KEY secret not configured", 500, corsHeaders);
  }

  if (agentType !== "code" && agentType !== "tool-calling") {
    return jsonError('agentType must be "code" or "tool-calling"', 400, corsHeaders);
  }

  // Clamp maxSteps to prevent runaway cost.
  const clampedMaxSteps = Math.min(maxSteps, MAX_STEPS_CAP);

  // C4: content-addressed cache key = SHA-256(authHeader + task + agentType + maxSteps + model).
  // The Authorization header is included so that different callers (different tokens)
  // cannot read each other's cached results even when submitting identical tasks.
  const MODEL_ID = AnthropicModels.SONNET_LATEST;
  const authHeader = request.headers.get("Authorization") ?? "";
  const kvKey = env.AGENTKIT_SESSIONS
    ? await contentHash({ auth: authHeader, task, agentType, maxSteps: clampedMaxSteps, model: MODEL_ID })
    : null;

  if (kvKey && env.AGENTKIT_SESSIONS) {
    const cached = await env.AGENTKIT_SESSIONS.get(kvKey, "text");
    if (cached) {
      if (useAgUiSse) {
        // Parse cached events and replay as AG-UI SSE.
        let events: AgentEvent[];
        try {
          events = JSON.parse(cached) as AgentEvent[];
        } catch {
          return jsonError("Cached session data is corrupted", 500, corsHeaders);
        }
        const agUiStream = toAgUiSseStream(
          (async function* () {
            yield* events;
          })(),
          agUiRunId
        );
        return new Response(agUiStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Agentkit-Cache": "HIT",
            ...corsHeaders,
          },
        });
      }
      return replayCachedSession(cached, corsHeaders, ctx);
    }
  }

  const model = new AnthropicModel(MODEL_ID, env.ANTHROPIC_API_KEY);

  // A3 — When CheckpointableRun wraps the agent, we want it to use the same
  // trace id as the event log; the binding below is set inside that block
  // so the event log path can pick it up.
  let explicitEventLogTraceId: string | null = null;

  const quickJSKernel = new QuickJSKernel({
    timeoutMs: 10_000,
    variant: cfVariant as unknown,
    variantLoader: newQuickJSWASMModuleFromVariant as unknown as NonNullable<
      QuickJSKernelOptions["variantLoader"]
    >,
  } satisfies QuickJSKernelOptions);

  // ── A1/A3: optional persistent checkpoint wrapper ─────────────────────────
  // When AGENTKIT_CHECKPOINTS is bound, every step + every await_human_input
  // is persisted to Workers KV so a paused / crashed run can be resumed.
  // `traceId` is reused from the SSE event log, so the same id navigates the
  // checkpoint store, event log, and (if used) session cache.
  let agentRun: AsyncGenerator<AgentEvent>;
  const codeAgent =
    agentType === "tool-calling"
      ? new ToolCallingAgent({ tools: [], model, maxSteps: clampedMaxSteps })
      : new CodeAgent({
          tools: [],
          model,
          maxSteps: clampedMaxSteps,
          kernel: quickJSKernel,
        });

  const baseRun = codeAgent.run(task);
  if (env.AGENTKIT_CHECKPOINTS) {
    const checkpointer = new KvCheckpointer(new CloudflareKvBackendImpl(env.AGENTKIT_CHECKPOINTS));
    // Reuse the same traceId we'll assign for the event log below.
    const checkpointTraceId = agUiRunId ?? kvKey ?? crypto.randomUUID();
    const wrapper = new CheckpointableRun({ checkpointer }, codeAgent.assembler);
    agentRun = wrapper.run(baseRun, task, checkpointTraceId);
    // Stash for the event-log section so it picks the same trace id.
    explicitEventLogTraceId = checkpointTraceId;
  } else {
    agentRun = baseRun;
  }

  // AG3: Respond with AG-UI SSE when the client requests it.
  if (useAgUiSse) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    ctx.waitUntil(
      (async () => {
        const allEvents: AgentEvent[] = [];
        let ranSuccessfully = false;
        try {
          const agUiStream = toAgUiSseStream(
            (async function* () {
              for await (const ev of agentRun) {
                // Always record final_answer; cap earlier events to MAX_KV_EVENTS.
                if (kvKey && env.AGENTKIT_SESSIONS) {
                  if (ev.event === "final_answer" || allEvents.length < MAX_KV_EVENTS) {
                    allEvents.push(ev);
                  }
                }
                if (ev.event === "final_answer") ranSuccessfully = true;
                yield ev;
              }
            })(),
            agUiRunId
          );
          const reader = agUiStream.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
          }
          if (kvKey && env.AGENTKIT_SESSIONS && ranSuccessfully && allEvents.length > 0) {
            try {
              await env.AGENTKIT_SESSIONS.put(kvKey, JSON.stringify(allEvents), {
                expirationTtl: SESSION_TTL_SECONDS,
              });
            } catch (err) {
              console.error(
                "[agentkit-worker] KV session write failed:",
                err instanceof Error ? err.message : String(err)
              );
            }
          }
        } catch (err) {
          try {
            const enc = new TextEncoder();
            const errEvent = JSON.stringify({
              type: "RUN_ERROR",
              runId: agUiRunId ?? "unknown",
              timestamp: Date.now(),
              data: {
                message: err instanceof Error ? err.message : String(err),
                code: "INTERNAL_ERROR",
              },
            });
            await writer.write(enc.encode(`event: RUN_ERROR\ndata: ${errEvent}\n\n`));
          } catch {
            /* consumer disconnected */
          }
        } finally {
          await writer.close().catch(() => {});
        }
      })()
    );

    return new Response(readable, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders },
    });
  }

  // Legacy raw AgentEvent SSE stream — A2: wraps the agent stream in an
  // EventLog so reconnects can resume via Last-Event-ID.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // traceId for the durable event log: prefer the checkpoint trace id (set
  // when AGENTKIT_CHECKPOINTS is bound, so checkpoints + events share an id),
  // then the AG-UI runId, then the content-hash session key (stable across
  // retries of the same task), and fall back to a fresh UUID for one-off runs.
  const eventLogTraceId = explicitEventLogTraceId ?? agUiRunId ?? kvKey ?? crypto.randomUUID();
  const eventLog = env.AGENTKIT_EVENT_LOG
    ? new EventLog(new CloudflareKvBackendImpl(env.AGENTKIT_EVENT_LOG))
    : null;
  const lastEventId = request.headers.get("Last-Event-ID");

  ctx.waitUntil(
    (async () => {
      const allEvents: AgentEvent[] = [];
      let ranSuccessfully = false;
      try {
        // ── Resume path: replay any persisted events the client missed. ──
        if (eventLog && lastEventId !== null) {
          for await (const logged of eventLog.replay(eventLogTraceId, lastEventId)) {
            await writer.write(encoder.encode(formatSseFrame(logged)));
          }
        }

        // Compute starting sequence so newly tapped events continue numbering
        // past the last persisted id (no gap, no duplicate id).
        const startSeq = eventLog ? await eventLog.nextSeq(eventLogTraceId) : 0;

        // ── Live path: tap + persist + emit. ─────────────────────────────
        const liveSource = eventLog
          ? eventLog.tap(agentRun, eventLogTraceId, { startSeq })
          : (async function* () {
              let i = startSeq;
              for await (const ev of agentRun) {
                yield { eventId: String(i++).padStart(12, "0"), event: ev };
              }
            })();

        for await (const logged of liveSource) {
          await writer.write(encoder.encode(formatSseFrame(logged)));
          const event = logged.event;
          if (kvKey && env.AGENTKIT_SESSIONS) {
            if (event.event === "final_answer" || allEvents.length < MAX_KV_EVENTS) {
              allEvents.push(event);
            }
          }
          if (event.event === "final_answer") ranSuccessfully = true;
        }
        await writer.write(encoder.encode("data: [DONE]\n\n"));

        // On clean completion, the run-level event log is no longer needed —
        // session cache (if enabled) is the long-lived artifact.
        if (eventLog && ranSuccessfully) {
          try {
            await eventLog.purge(eventLogTraceId);
          } catch (err) {
            console.error(
              "[agentkit-worker] EventLog purge failed:",
              err instanceof Error ? err.message : String(err)
            );
          }
        }

        if (kvKey && env.AGENTKIT_SESSIONS && ranSuccessfully && allEvents.length > 0) {
          try {
            await env.AGENTKIT_SESSIONS.put(kvKey, JSON.stringify(allEvents), {
              expirationTtl: SESSION_TTL_SECONDS,
            });
          } catch (err) {
            console.error(
              "[agentkit-worker] KV session write failed:",
              err instanceof Error ? err.message : String(err)
            );
          }
        }
      } catch (err) {
        try {
          const errEvent = {
            event: "error",
            data: { error: err instanceof Error ? err.message : String(err) },
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(errEvent)}\n\n`));
        } catch {
          /* consumer disconnected */
        }
      } finally {
        await writer.close().catch(() => {});
      }
    })()
  );

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      // Echo back the traceId so clients that lose their cookie can resume
      // explicitly; pair with Last-Event-ID on reconnect.
      "X-Agentkit-Trace-Id": eventLogTraceId,
      ...corsHeaders,
    },
  });
}

/**
 * Replay a cached session from KV as a streaming SSE response (C4).
 * The cached value is a JSON array of AgentEvent objects.
 */
function replayCachedSession(
  cachedJson: string,
  corsHeaders: Record<string, string>,
  ctx: ExecutionContext
): Response {
  let events: AgentEvent[];
  try {
    events = JSON.parse(cachedJson) as AgentEvent[];
  } catch {
    // Corrupted cache entry — treat as cache miss by returning an error.
    return jsonError("Cached session data is corrupted", 500, corsHeaders);
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  ctx.waitUntil(
    (async () => {
      try {
        for (const event of events) {
          await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch {
        /* consumer disconnected */
      } finally {
        await writer.close().catch(() => {});
      }
    })()
  );

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Agentkit-Cache": "HIT",
      ...corsHeaders,
    },
  });
}

/**
 * Content-addressed cache key: SHA-256 hex of the run's deterministic inputs (C4).
 *
 * Using content hash instead of bare sessionId prevents a different task with the
 * same sessionId from hitting a stale cache entry.
 * `crypto.subtle` is available in the Workers global scope.
 */
async function contentHash(inputs: {
  auth: string;
  task: string;
  agentType: string;
  maxSteps: number;
  model: string;
}): Promise<string> {
  const material = JSON.stringify(inputs);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return `run:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
