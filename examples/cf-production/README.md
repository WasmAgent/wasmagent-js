# cf-production — Production-ready Cloudflare Workers deployment

Demonstrates the full M5 stack:
- JWT auth (HS256)
- Per-user rate limiting (KV-backed)
- D1 run history
- Durable Objects for long-running agents
- Webhooks on completion
- OpenTelemetry export with sampling + redaction

## 1. Wrangler config

`wrangler.toml`:

```toml
name = "WasmAgent-prod"
main = "src/index.ts"
compatibility_date = "2026-06-01"
node_compat = false

# KV — sessions + rate limiting + DLQ
[[kv_namespaces]]
binding = "AGENTKIT_SESSIONS"
id = "<your-session-kv-id>"

[[kv_namespaces]]
binding = "AGENTKIT_RATELIMIT"
id = "<your-ratelimit-kv-id>"

[[kv_namespaces]]
binding = "AGENTKIT_DLQ"
id = "<your-dlq-kv-id>"

# D1 — run history
[[d1_databases]]
binding = "AGENTKIT_DB"
database_name = "WasmAgent_runs"
database_id = "<your-d1-id>"

# Durable Object — long-running agents
[[durable_objects.bindings]]
name = "AGENT_DO"
class_name = "AgentDurableObject"

[[migrations]]
tag = "v1"
new_classes = ["AgentDurableObject"]

# Vars — public config
[vars]
AGENTKIT_LOG_LEVEL = "info"

# Secrets (set with `wrangler secret put`):
#   ANTHROPIC_API_KEY
#   AGENTKIT_JWT_SECRET
#   WEBHOOK_URLS
#   WEBHOOK_SECRET
#   OTEL_EXPORTER_OTLP_ENDPOINT
```

## 2. D1 schema

```bash
wrangler d1 create WasmAgent_runs
wrangler d1 execute WasmAgent_runs --command "
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  task TEXT NOT NULL,
  agent_type TEXT,
  model TEXT,
  status TEXT NOT NULL,
  final_answer TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_user_runs ON runs(user_id, created_at DESC);
"
```

## 3. Issue a JWT

```bash
node -e '
const crypto = require("crypto");
const secret = "your-secret";
const payload = {
  sub: "user-1",
  scopes: ["agent:run"],
  iat: Math.floor(Date.now()/1000),
  exp: Math.floor(Date.now()/1000) + 3600,
};
const b64 = (s) => Buffer.from(s).toString("base64url");
const header = b64(JSON.stringify({alg:"HS256",typ:"JWT"}));
const body = b64(JSON.stringify(payload));
const sig = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
console.log(`${header}.${body}.${sig}`);
'
```

## 4. Test against the deployed Worker

```bash
TOKEN="<jwt from step 3>"
curl -X POST https://WasmAgent-prod.your-subdomain.workers.dev/run \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task":"What is 2+2?", "agentType":"tool-calling"}'
```

## 5. Long-running runs (Durable Objects)

For tasks expected to exceed 30s CPU / 5min wall-clock:

```bash
curl -X POST .../run/long  -H "Authorization: ..." -d '{"task":"..."}'
# → { "runId": "abc", "sseUrl": ".../run/abc/stream", "statusUrl": ".../run/abc/status" }
curl .../run/abc/stream  # SSE
curl .../run/abc/status  # JSON status
```

## 6. Run history & aggregates

```bash
curl ".../runs?userId=user-1&limit=20" -H "Authorization: ..."
curl ".../runs/aggregate?userId=user-1" -H "Authorization: ..."
```

## 7. Webhooks

When `WEBHOOK_URLS` secret is set, every completed run POSTs:

```json
{
  "event": "run.completed",
  "runId": "abc",
  "userId": "user-1",
  "answer": "...",
  "tokenUsage": { "input": 1200, "output": 500 },
  "costUsd": 0.014,
  "durationMs": 8200,
  "emittedAt": "2026-06-10T12:34:56Z"
}
```

If `WEBHOOK_SECRET` is set, the receiver should verify
`X-Agentkit-Signature: sha256=<hex>`.

## 8. OTEL export

When `OTEL_EXPORTER_OTLP_ENDPOINT` env var points to a collector
(Jaeger, Tempo, Datadog, etc.), every run pushes spans + metrics
automatically. Configure sampling via `OTEL_SAMPLER` (`always`,
`probabilistic:0.1`, `ratelimit:100`).

## See also

- [otel-jaeger example](../otel-jaeger/) — Jaeger backend with
  docker-compose
- [`@wasmagent/cloudflare-worker` README](../../packages/cloudflare-worker/README.md)
