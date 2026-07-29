---
"@wasmagent/aep": minor
"@wasmagent/otel-exporter": minor
---

feat(aep,otel-exporter): real-time evidence streaming with `EvidencePublisher` + OTLP transport (Milestone 7, #276).

Adds a top-level real-time streaming surface for AEP evidence and an OpenTelemetry transport that mirrors the live feed into any OTLP/HTTP collector — the "real-time evidence streaming with `EvidencePublisher` for live monitoring dashboards and external observability pipelines (OpenTelemetry integration)" bullet.

- **`@wasmagent/aep` — `EvidencePublisher`** (`packages/aep/src/evidencePublisher.ts`): wraps an `EvidenceStream` and adds (1) **push mode** — `publish(record)` streams each record to subscribers + transports, and (2) **watch mode** — `start()`/`stop()` poll a configured `EvidenceStore` on a fixed cadence and stream records appended *after* start (never replaying the pre-existing tail), with an optional content `filter` applied to pulled records. Exposes `subscribe`/`addTransport` (live dashboards + any `StreamTransportOutbound`), lifecycle counters via `stats`, and a `close()` that tears down the underlying stream. Best-effort and fail-soft: a failing subscriber/transport or a transient store-query error is counted in `stats.errors` and never aborts the fan-out or stops the poll loop.
- **`@wasmagent/otel-exporter` — `OtlpEvidenceTransport`** (`packages/otel-exporter/src/evidenceOtlpTransport.ts`): a `StreamTransportOutbound` that converts each record's actions into OTLP trace spans (reusing `aepActionToOtelSpan`, one span per action, all scoped to the run's trace id) and POSTs them to `<endpoint>/v1/traces` with exponential-backoff retry (5xx/network retryable, 4xx not). Also exports `aepRecordToOtlpSpans(record)` for inspecting the span projection without network access. References `@wasmagent/aep` **only via `import type`** (devDependency) — zero runtime dependency on the evidence layer, mirroring the `core/shared-state/aep` pattern.
