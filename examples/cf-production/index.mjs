/**
 * cf-production — minimal Cloudflare Workers entry point.
 *
 * Drop-in replacement that wires @wasmagent/core directly in a Worker:
 *   - JWT auth (HS256 via Web Crypto)
 *   - Per-user rate limiting (KV-backed)
 *   - Streaming agent run via SSE
 *
 * Deploy:
 *   cp wrangler.toml.example wrangler.toml  # fill KV + D1 IDs
 *   wrangler secret put ANTHROPIC_API_KEY
 *   wrangler secret put JWT_SECRET
 *   wrangler deploy
 *
 * Try locally (no KV needed — falls back to memory):
 *   wrangler dev
 *   curl -H "Authorization: Bearer $(node -e "
 *     const {createHmac}=require('crypto');
 *     const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
 *     const p=Buffer.from(JSON.stringify({sub:'u1',exp:Math.floor(Date.now()/1e3)+3600})).toString('base64url');
 *     const s=createHmac('sha256','dev-secret').update(h+'.'+p).digest('base64url');
 *     console.log(h+'.'+p+'.'+s)
 *   ")" \
 *   -d '{"task":"Calculate 2+2"}' \
 *   http://localhost:8787/run
 */

import { AnthropicModel, CodeAgent, EventLog } from "@wasmagent/core";

// ── auth ─────────────────────────────────────────────────────────────────────

async function verifyJwt(authHeader, secret) {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
    new TextEncoder().encode(`${header}.${payload}`)
  );
  if (!valid) return null;
  const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}

// ── rate limiting (KV-backed, falls back to no-op) ───────────────────────────

async function checkRateLimit(kv, userId, limitPerMinute = 10) {
  if (!kv) return true;
  const key = `rl:${userId}:${Math.floor(Date.now() / 60_000)}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= limitPerMinute) return false;
  await kv.put(key, String(count + 1), { expirationTtl: 120 });
  return true;
}

// ── Worker entry ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/run" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    // Auth
    const claims = await verifyJwt(
      request.headers.get("Authorization"),
      env.JWT_SECRET ?? "dev-secret"
    );
    if (!claims) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Rate limit
    const allowed = await checkRateLimit(env.AGENTKIT_RATELIMIT, claims.sub);
    if (!allowed) {
      return new Response("Rate limit exceeded", { status: 429 });
    }

    // Parse body
    let task;
    try {
      const body = await request.json();
      task = body.task;
      if (!task || typeof task !== "string") throw new Error("task required");
    } catch (e) {
      return new Response(`Bad request: ${e.message}`, { status: 400 });
    }

    // Stream SSE response
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();

    const send = (event, data) =>
      writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

    (async () => {
      try {
        const model = new AnthropicModel({
          apiKey: env.ANTHROPIC_API_KEY,
          model: "claude-haiku-4-5-20251001",
        });
        const log = new EventLog();
        const agent = new CodeAgent({ model, tools: [], maxSteps: 10, eventLog: log });
        for await (const evt of agent.run(task)) {
          await send(evt.event, evt.data);
        }
        await send("done", { traceId: log.traceId });
      } catch (err) {
        await send("error", { message: err.message });
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  },
};
