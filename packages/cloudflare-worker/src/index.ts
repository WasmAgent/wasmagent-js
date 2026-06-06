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
 * ── Edge Runtime Compatibility (A3) ──────────────────────────────────────────
 * Cloudflare Workers does NOT provide node:vm (the module used by JsKernel and
 * V8WasmKernel). The CodeAgent constructor calls createKernel() which instantiates
 * JsKernel — this WILL fail at runtime in workerd.
 *
 * Fix path (tracked as plan task A3):
 *   1. Add a Workers-safe kernel that uses eval() or Realm (TC39 proposal) instead
 *      of node:vm, OR expose a no-code ToolCallingAgent-only path for Workers.
 *   2. Until fixed, agentType:"tool-calling" (ToolCallingAgent) is the only safe
 *      mode in Workers because it does NOT execute code — only calls tools.
 *   3. agentType:"code" (CodeAgent) will fail in workerd; use it only in Node.
 *
 * This is documented so CI can add a workerd smoke-test that catches regressions.
 */

import { CodeAgent, ToolCallingAgent, AnthropicModel } from "@agentkit-js/core";
import type { AgentEvent } from "@agentkit-js/core";

export interface Env {
  ANTHROPIC_API_KEY: string;
  AGENTKIT_LOG_LEVEL?: string;
  /** Optional KV namespace for session result caching (C4). */
  AGENTKIT_SESSIONS?: KVNamespace;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
} as const;

const SESSION_TTL_SECONDS = 3600; // 1 hour

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: CORS_HEADERS });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json(
        { status: "ok", version: "0.1.0" },
        { headers: CORS_HEADERS }
      );
    }

    if (url.pathname === "/run" && request.method === "POST") {
      return handleRun(request, env);
    }

    return jsonError("Not Found", 404);
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
    typeof v === "object" &&
    v !== null &&
    "task" in v &&
    typeof (v as RunBody).task === "string"
  );
}

async function handleRun(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!isRunBody(body)) {
    return jsonError('Body must include { "task": string }', 400);
  }

  const { task, agentType = "code", maxSteps = 10, sessionId } = body;

  if (!env.ANTHROPIC_API_KEY) {
    return jsonError("ANTHROPIC_API_KEY secret not configured", 500);
  }

  if (agentType !== "code" && agentType !== "tool-calling") {
    return jsonError('agentType must be "code" or "tool-calling"', 400);
  }

  // C4: content-addressed cache key = SHA-256(task + agentType + maxSteps + model).
  // sessionId is an optional grouping/audit label; the content hash is the actual key.
  // This prevents a different task with the same sessionId from returning stale results.
  const MODEL_ID = "claude-sonnet-4-6";
  const kvKey = env.AGENTKIT_SESSIONS
    ? await contentHash({ task, agentType, maxSteps, model: MODEL_ID })
    : null;

  if (kvKey && env.AGENTKIT_SESSIONS) {
    const cached = await env.AGENTKIT_SESSIONS.get(kvKey, "text");
    if (cached) {
      return replayCachedSession(cached);
    }
  }

  const model = new AnthropicModel(MODEL_ID, env.ANTHROPIC_API_KEY);

  const agentRun: AsyncGenerator<AgentEvent> =
    agentType === "tool-calling"
      ? new ToolCallingAgent({ tools: [], model, maxSteps }).run(task)
      : new CodeAgent({ tools: [], model, maxSteps }).run(task);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    const allEvents: AgentEvent[] = [];
    let ranSuccessfully = false;
    try {
      for await (const event of agentRun) {
        const line = `data: ${JSON.stringify(event)}\n\n`;
        await writer.write(encoder.encode(line));
        if (kvKey && env.AGENTKIT_SESSIONS) allEvents.push(event);
        if (event.event === "final_answer") ranSuccessfully = true;
      }
      await writer.write(encoder.encode("data: [DONE]\n\n"));

      // C4: only cache runs that completed with a final_answer.
      // Errors and partial runs are not cached to avoid poisoning the cache.
      if (kvKey && env.AGENTKIT_SESSIONS && ranSuccessfully && allEvents.length > 0) {
        await env.AGENTKIT_SESSIONS.put(
          kvKey,
          JSON.stringify(allEvents),
          { expirationTtl: SESSION_TTL_SECONDS }
        );
      }
    } catch (err) {
      const errEvent = {
        event: "error",
        data: { error: err instanceof Error ? err.message : String(err) },
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(errEvent)}\n\n`));
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      ...CORS_HEADERS,
    },
  });
}

/**
 * Replay a cached session from KV as a streaming SSE response (C4).
 * The cached value is a JSON array of AgentEvent objects.
 */
function replayCachedSession(cachedJson: string): Response {
  let events: AgentEvent[];
  try {
    events = JSON.parse(cachedJson) as AgentEvent[];
  } catch {
    // Corrupted cache entry — treat as cache miss by returning an error.
    return jsonError("Cached session data is corrupted", 500);
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    for (const event of events) {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    }
    await writer.write(encoder.encode("data: [DONE]\n\n"));
    await writer.close();
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Agentkit-Cache": "HIT",
      ...CORS_HEADERS,
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
  task: string;
  agentType: string;
  maxSteps: number;
  model: string;
}): Promise<string> {
  const material = JSON.stringify(inputs);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material)
  );
  return "run:" + [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
