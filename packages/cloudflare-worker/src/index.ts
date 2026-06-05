/**
 * Cloudflare Workers entry point for agentkit-js.
 *
 * Exposes a simple HTTP API:
 *   POST /run   { task: string }  → Server-Sent Events stream of AgentEvent
 *   GET  /health                  → { status: "ok" }
 *
 * The Worker uses JsKernel (zero native deps) so it runs in the V8 isolate
 * without requiring wasmtime (A1 dual-engine fallback).
 */

import { CodeAgent, AnthropicModel } from "@agentkit-js/core";

export interface Env {
  ANTHROPIC_API_KEY: string;
  AGENTKIT_LOG_LEVEL?: string;
  // AGENTKIT_SESSIONS: KVNamespace;  // optional session caching (C4)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok", version: "0.1.0" });
    }

    if (url.pathname === "/run" && request.method === "POST") {
      return handleRun(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleRun(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("task" in body) ||
    typeof (body as { task: unknown }).task !== "string"
  ) {
    return Response.json(
      { error: 'Body must be { "task": string }' },
      { status: 400 }
    );
  }

  const { task } = body as { task: string };

  if (!env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY secret not configured" },
      { status: 500 }
    );
  }

  const model = new AnthropicModel(
    "claude-sonnet-4-6",
    env.ANTHROPIC_API_KEY
  );
  const agent = new CodeAgent({ tools: [], model, maxSteps: 10 });

  // Stream agent events as Server-Sent Events.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
      for await (const event of agent.run(task)) {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        await writer.write(encoder.encode(data));
      }
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } catch (err) {
      const errData = `data: ${JSON.stringify({ event: "error", data: String(err) })}\n\n`;
      await writer.write(encoder.encode(errData));
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
