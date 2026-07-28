---
"@wasmagent/aep": minor
---

feat(aep): real-time evidence monitoring hooks — webhook subscriptions, WebSocket streaming, and in-process compliance-dashboard observers (Milestone 6, #265).

Adds `packages/aep/src/evidenceMonitor.ts`, building on the `EvidenceStream` pub/sub primitives with three ready-to-use monitoring hook types plus a unified container:

- **Webhook subscriptions** — `WebhookMonitorHook` (implements `StreamTransportOutbound`): POSTs each evidence event to one or more HTTPS URLs with HMAC-SHA-256 signing (`X-Wasmagent-Signature`), exponential-backoff retries, an SSRF guard (`validateWebhookUrl` rejects private/internal ranges and non-HTTPS schemes at construction time), an optional dead-letter backend, and a configurable payload transform (`defaultWebhookPayload` hoists `run_id`/`model_id` and nests the full record).
- **WebSocket streaming** — `WebSocketMonitorHook`: serializes each event onto a `WebSocketLike` connection; events arriving while the socket is not yet open are counted as dropped (`droppedCount`/`sentCount`/`lastError`) and never abort the surrounding publish fan-out.
- **In-process observers** — `ComplianceDashboardObserver`: aggregates matching events into a `ComplianceDashboardSnapshot` (counts by `run_id`, `tool_name`, `side_effect_class`, and `model_id`, plus a bounded rolling `recent` window and first/last-seen timestamps) that compliance dashboards read synchronously, with `reset()` and an optional `onEvent` callback.
- **`EvidenceMonitor`** — a thin container wiring all three hook types onto a single `EvidenceStream` via `addWebhook` / `addWebSocket` / `observe`, with shared `publish` and `close` lifecycle.

All hooks are filter-aware (reusing `matchesFilter` query semantics) and best-effort: a failing hook never blocks delivery to the others.
