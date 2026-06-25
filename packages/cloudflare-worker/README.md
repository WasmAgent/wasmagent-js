# @wasmagent/cloudflare-worker

> **Maturity: alpha** — may change without notice; production use at your own risk.

Cloudflare Workers entry point for WasmAgent — HTTP API for agent runs with SSE streaming and KV session caching.

---

## What it does

Exposes a minimal HTTP API from a Cloudflare Worker:

| Route | Method | Description |
|---|---|---|
| `/health` | GET | `{ status: "ok", version: string }` |
| `/run` | POST | SSE stream of `AgentEvent` |

The `/run` endpoint supports `code` and `tool-calling` agent types, optional session caching via Cloudflare KV, and QuickJS WASM sandboxing (compatible with Cloudflare's no-runtime-compilation constraint).

---

## Deploy

```bash
# Install wrangler
npm install -g wrangler

# Deploy
wrangler deploy --config packages/cloudflare-worker/wrangler.toml
```

---

## Usage

```bash
# Health check
curl https://your-worker.workers.dev/health

# Run a code agent (streaming SSE)
curl -N -X POST https://your-worker.workers.dev/run \
  -H "Content-Type: application/json" \
  -d '{"task": "What is 42 * 1337?", "agentType": "code", "maxSteps": 5}'
```

---

## POST /run body

```ts
{
  task: string           // The task to run
  agentType?: "code" | "tool-calling"   // default: "code"
  maxSteps?: number      // default: 10
  sessionId?: string     // enables KV-backed result caching (TTL: 1 hour)
}
```

When `WASMAGENT_SESSIONS` KV is bound and `sessionId` is provided, completed results are cached. Subsequent requests with the same `sessionId` replay the cached event stream instantly.

---

## KV session caching

Bind a KV namespace in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "WASMAGENT_SESSIONS"
id = "your-kv-namespace-id"
```

---

## License

Apache-2.0
