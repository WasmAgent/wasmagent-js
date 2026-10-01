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
  /** Optional auth check. Return true to allow, false to reject with 401. */
  auth?: (request: Request) => boolean | Promise<boolean>;
  /** Maximum request body size in bytes. Default 1048576 (1 MiB). */
  maxBodyBytes?: number;
  /** Maximum batch request size. Default 20. */
  maxBatchSize?: number;
}

export function createFetchHandler(
  server: McpAgentServer,
  opts: CreateFetchHandlerOptions = {}
): (request: Request) => Promise<Response> {
  const path = opts.path ?? "/mcp";
  const allowOrigin = opts.allowedOrigin ?? "*";
  const maxBodyBytes = opts.maxBodyBytes ?? 1_048_576;
  const maxBatchSize = opts.maxBatchSize ?? 20;
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
    if (opts.auth) {
      const allowed = await opts.auth(request);
      if (!allowed) {
        return jsonResp(
          { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } },
          401,
          allowOrigin
        );
      }
    }
    // Read the raw bytes first so the size check applies even when
    // Content-Length is absent (chunked transfer-encoding, etc.).
    let buf: ArrayBuffer;
    try {
      buf = await request.arrayBuffer();
    } catch {
      return jsonResp(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } },
        400,
        allowOrigin
      );
    }
    if (buf.byteLength > maxBodyBytes) {
      return jsonResp(
        { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Request body too large" } },
        413,
        allowOrigin
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(buf));
    } catch {
      return jsonResp(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } },
        400,
        allowOrigin
      );
    }

    // Batch support: spec allows an array of requests, each handled
    // independently. Notifications (JSON-RPC object with a method but no id)
    // are handled for side effects and get NO response entry — responding to
    // them would violate JSON-RPC 2.0 batch semantics (and this handler's own
    // documented intent; surfaced as GAP-BATCH-NOTIF in the protocol matrix).
    // Non-object batch items keep their parse-error responses (id null).
    if (Array.isArray(body)) {
      if (body.length > maxBatchSize) {
        return jsonResp(
          { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Batch too large" } },
          413,
          allowOrigin
        );
      }
      const handled = await Promise.all(
        body.map(async (b) => {
          const isNotification =
            typeof b === "object" &&
            b !== null &&
            "method" in (b as Record<string, unknown>) &&
            !("id" in (b as Record<string, unknown>));
          const h = await server.handle(b);
          return isNotification ? undefined : h.response;
        })
      );
      const responses = handled.filter((r) => r !== undefined);
      if (responses.length === 0) {
        return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
      }
      return jsonResp(responses, 200, allowOrigin);
    }
    // Single notification over Streamable HTTP: accepted, no response body
    // (202 Accepted), per the MCP transport spec.
    const isNotification =
      typeof body === "object" &&
      body !== null &&
      "method" in (body as Record<string, unknown>) &&
      !("id" in (body as Record<string, unknown>));
    const result = await server.handle(body);
    if (isNotification) {
      return new Response(null, { status: 202, headers: corsHeaders(allowOrigin) });
    }
    return jsonResp(result.response, 200, allowOrigin);
  };
}

function corsHeaders(allowOrigin: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
  };
  if (allowOrigin !== "*") headers.Vary = "Origin";
  return headers;
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
