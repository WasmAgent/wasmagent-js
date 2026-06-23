# Production Deployment Checklist

Use this checklist before going live with WasmAgent in a production environment.
Each item links to the relevant configuration documentation.

---

## Authentication

- [ ] **`clientToken` set** — configure as a Cloudflare Workers secret
  (`wrangler secret put CLIENT_TOKEN`). All API requests must present this
  token in the `Authorization: Bearer <token>` header.
- [ ] **CORS locked to known origin** — set `WASMAGENT_ALLOWED_ORIGIN` to
  your frontend's domain. Do not use `*` in production.
- [ ] **`allowLocalSessionFallback` NOT set** — this flag allows requests
  without `X-Session-Id` to fall back to a local session, which disables
  session isolation. It must be absent or `false` in production.

---

## Session isolation

- [ ] **`X-Session-Id` required on all file/run/job endpoints** — the worker
  must reject requests that omit this header with HTTP 400.
- [ ] **Session IDs are server-generated** — do not allow clients to supply
  arbitrary session ID values. Generate them server-side and bind them to
  authenticated user identities.
- [ ] **`SessionKvStore` in use** — verify that all KV reads and writes go
  through `SessionKvStore` (which namespaces keys under `session:<id>:...`)
  rather than raw KV puts/gets.

---

## Kernel policy

- [ ] **WASM kernel selected** — use `QuickJSKernel` or `WasmtimeKernel`
  rather than `JsKernel` (Node.js `vm`). See
  [capability-manifest-guide.md](capability-manifest-guide.md) for kernel
  selection guidance.
- [ ] **`CapabilityManifest` restricts file paths to workspace** —
  `allowedReadPaths` and `allowedWritePaths` must be scoped to
  `/workspace/<sessionId>` or narrower. Paths like `/`, `/etc`, or `/home`
  must not appear.
- [ ] **`allowedHosts` is not a wildcard** — `allowedHosts: ["*"]` grants
  unrestricted outbound network access. In production, list specific domain
  names only.
- [ ] **`cpuMs` and `memoryLimitMb` set** — every kernel construction must
  include a per-invocation CPU deadline and a memory ceiling. Omitting these
  allows runaway code to monopolise worker resources.
- [ ] **`ApprovalPolicy` set to `strict()` or `balanced()`** — `permissive()`
  (the default) allows all writes without human approval. At minimum, use
  `balanced()` in production. See
  [capability-manifest-guide.md](capability-manifest-guide.md).

---

## Data integrity

- [ ] **Build-result nonce enabled** — configure `buildResultsKv` binding in
  `wrangler.toml`. Without this, the `/build-result` endpoint does not verify
  nonces and forged build results can be accepted.
- [ ] **G3 contamination guard active** — run all training exports with
  `--mode production` to engage the `n_gram_hash` deduplication check. Do not
  ship training data that has not passed the G3 gate.
- [ ] **Eval-items JSONL stored separately from rollout data** — the eval
  fixture set (`eval-items.jsonl`) must not be co-located in the same KV
  prefix or S3 bucket as rollout data. A separate namespace prevents accidental
  contamination.

---

## Observability

- [ ] **`EventLog` persisted to KV** — configure `checkpointsKv` binding so
  that all agent events are durably stored. Without this, events are in-memory
  only and lost on process restart.
- [ ] **OTel export configured** — optional but recommended for production
  monitoring. Wire `model_start` / `model_done` / `guardrail_tripwire` events
  to your OTel collector. See [audit-events.md](audit-events.md).
- [ ] **Error log retention period set** — configure a TTL or purge schedule
  for KV event keys. The `EventLog` does not auto-expire entries.
- [ ] **`guardrail_tripwire` events alerted** — set up an alert or dashboard
  query for `guardrail_tripwire` events. A sudden spike indicates an active
  injection attempt or a misconfigured guardrail.

---

## Rollout data (RLAIF pipeline)

- [ ] **`allowLocalSessionFallback: false`** — confirmed absent or false (see
  Authentication section above).
- [ ] **Rollout export endpoint restricted by `sessionId`** — the
  `/rollouts/export` and `/jobs/:id/rollout-export` endpoints must require
  `X-Session-Id` and return only data for that session.
- [ ] **Training exports require G3 check** — automate the G3 guard as a CI
  step; never ship a training batch that has not been validated by
  `validate-rlaif.mjs`.
- [ ] **`buildResultsKv` namespace not publicly accessible** — the KV
  namespace storing build-result nonces must be bound only to the worker's
  service binding. External write access to this namespace would allow nonce
  forgery.

---

## Guardrails (if used)

- [ ] **`classifierGuardrail` wired with `onError: "closed"`** — fail-closed
  on classifier errors means the agent is blocked if the safety classifier
  is unavailable. Appropriate for high-privilege sessions.
- [ ] **`intentAlignmentGuardrail` applied to high-privilege tools** — wrap
  tools that can delete files, execute shell commands, or make external API
  calls.
- [ ] **`redactPostHook` applied to tool outputs** — strip API key patterns
  and PII before tool results enter the agent's context window and before they
  are persisted to the `EventLog`.

---

## Pre-launch verification

Run the following before directing production traffic to a new deployment:

```bash
# 1. Confirm WASM kernel is in use (not JsKernel)
wrangler tail --format=json | grep '"kernel_type"'

# 2. Confirm session isolation: write in session A, attempt read in session B
# (See pilot-script.md Scenario 2 for the full test procedure)

# 3. Confirm capability deny: attempt to read /etc/passwd
# (See pilot-script.md Scenario 1 for the full test procedure)

# 4. Confirm build-result nonce: attempt to POST /build-result without nonce
curl -X POST https://your-worker.example.com/build-result \
  -H "Content-Type: application/json" \
  -d '{"jobId":"fake","status":"success"}' \
  # Expected: HTTP 403 Forbidden

# 5. Confirm rollout export auth: attempt GET /rollouts/export without session ID
curl https://your-worker.example.com/rollouts/export
# Expected: HTTP 400 Bad Request (missing X-Session-Id)
```

---

*See also: [pilot-script.md](pilot-script.md) for the 30-minute enterprise
pilot procedure that produces evidence artifacts for each of these controls.*
