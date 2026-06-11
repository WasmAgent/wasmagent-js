/**
 * F1 — Fetch handler adapter.
 *
 * Wraps an {@link McpAgentServer} into a `(Request) => Promise<Response>`
 * function so hosts that speak Streamable HTTP (Cloudflare Workers, Hono,
 * Bun.serve, etc.) can plug it in with one line. Keeps the server
 * transport-agnostic — the same `McpAgentServer` instance can be exposed
 * over stdio framing by a different adapter without code changes.
 */

import type { McpAgentServer } from "./McpAgentServer.js";

export interface CreateFetchHandlerOptions {
  /** Path the MCP server lives on. Default `/mcp`. */
  path?: string;
  /** CORS allowed origin. Default `"*"`. */
  allowedOrigin?: string;
}

export function createFetchHandler(
  server: McpAgentServer,
  opts: CreateFetchHandlerOptions = {}
): (request: Request) => Promise<Response> {
  const path = opts.path ?? "/mcp";
  const allowOrigin = opts.allowedOrigin ?? "*";
  return async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname !== path) {
      return new Response("Not Found", { status: 404 });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(allowOrigin),
      });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders(allowOrigin) });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResp(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } },
        400,
        allowOrigin
      );
    }

    // Batch support: spec allows an array of requests, each handled
    // independently. Notifications (no id) get no response and are filtered.
    if (Array.isArray(body)) {
      const handled = await Promise.all(body.map((b) => server.handle(b)));
      const responses = handled.map((h) => h.response).filter((r) => r.id !== undefined);
      return jsonResp(responses, 200, allowOrigin);
    }
    const result = await server.handle(body);
    // For notifications (id absent) the spec wants no body — but JSON-RPC
    // 2.0 also tolerates an empty 200; we choose 200 with an empty array to
    // avoid clients hanging waiting for a response.
    return jsonResp(result.response, 200, allowOrigin);
  };
}

function corsHeaders(allowOrigin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
    Vary: allowOrigin === "*" ? "" : "Origin",
  };
}

function jsonResp(payload: unknown, status: number, allowOrigin: string): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(allowOrigin),
    },
  });
}
