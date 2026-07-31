# `@wasmagent/otel-exporter` — AEP → OTel Span Mapping

This document is the authoritative mapping between AEP record fields and the
OpenTelemetry span attributes emitted by `@wasmagent/otel-exporter`.

Source: `packages/otel-exporter/src/aep-otel-bridge.ts`,
`packages/otel-exporter/src/aep-span-names.ts`

---

## Span name convention

All AEP action evidence records are emitted as spans with name **`tool.call`**
(`AEP_SPAN_NAMES.TOOL_CALL`). This aligns with the OpenTelemetry GenAI semantic
conventions for tool invocations.

---

## AEP field → OTel span attribute mapping

### Identity and tracing

| AEP field | OTel attribute | Type | Notes |
|---|---|---|---|
| `actions[].action_id` | `spanId` | string (16 hex chars) | First 16 chars of action_id, right-padded with `0` |
| `actions[].parent_action_id` | `parentSpanId` | string (16 hex chars) | Same padding rule |
| `run_id` | `traceId` | string (32 hex chars) | First 32 chars of run_id, right-padded |
| `run_id` | `aep.run_id` | string | Also stored as a span attribute for SIEM query |
| `actions[].timestamp_ms` | `startTimeUnixNano` | number | `timestamp_ms * 1_000_000` |

### Action properties

| AEP field | OTel attribute | Type |
|---|---|---|
| `actions[].tool_name` | `aep.tool_name` | string |
| `actions[].state_changing` | `aep.state_changing` | boolean |
| `actions[].causal_chain_id` | `aep.causal_chain_id` | string |
| `actions[].scope_lease_id` | `aep.scope_lease_id` | string |
| `actions[].result_digest` | `aep.result_digest` | string |
| `actions[].pre_state_digest` | `aep.pre_state_digest` | string |
| `actions[].post_state_digest` | `aep.post_state_digest` | string |

### Taint propagation

| AEP field | OTel attribute | Type |
|---|---|---|
| `actions[].input_taint_labels` | `aep.input_taint_labels` | string[] |
| `actions[].output_taint_labels` | `aep.output_taint_labels` | string[] |

### Policy / capability decision

| AEP field | OTel attribute | Type |
|---|---|---|
| `capability_decisions[].decision` | `aep.policy_decision` | string (`allow`/`deny`/`ask_user`/`dry_run`) |
| `capability_decisions[].capability` | `aep.policy_capability` | string |
| `capability_decisions[].reason_code` | `aep.policy_reason_code` | string |

### GenAI semantic conventions

| OTel attribute | Value | Source |
|---|---|---|
| `gen_ai.operation.name` | `"tool_call"` | `GENAI_SEMCONV.ATTR_OPERATION_NAME` |

---

## Reverse mapping: OTel span → AEP action

`otelSpanToAepAction()` converts back from an OTel span to an `AepActionLike` object.
Only spans with `name === "tool.call"` are convertible; all others return `null`.

This round-trip is used to import OTel GenAI traces from third-party collectors into
AEP evidence records for audit and training data pipelines.

---

## Ingesting into Datadog / Grafana / Splunk

### Datadog

```ts
import { AepOtlpTransport } from '@wasmagent/otel-exporter'

const transport = new AepOtlpTransport({
  endpoint: 'https://trace.agent.datadoghq.com',
  headers: { 'DD-API-KEY': process.env.DD_API_KEY! },
})
```

In Datadog, filter by `aep.run_id` to find all spans for a specific agent run.
Use `aep.policy_decision = "deny"` as a saved search to surface blocked capability
attempts.

### Grafana / Tempo

```ts
const transport = new AepOtlpTransport({
  endpoint: 'http://tempo:4318/v1/traces',   // OTLP HTTP endpoint
})
```

In Grafana Explore → Traces, query by `aep.state_changing = true` to find all
runs that mutated state, then correlate with `aep.input_taint_labels` to identify
which ran on untrusted input.

### Splunk

Send spans via the OTLP HTTP exporter to Splunk Observability Cloud:

```ts
const transport = new AepOtlpTransport({
  endpoint: 'https://ingest.<realm>.signalfx.com/v2/trace/otlp',
  headers: { 'X-SF-Token': process.env.SPLUNK_TOKEN! },
})
```

Splunk SPL query for high-severity policy blocks:
```
| mstats count WHERE aep.policy_decision="deny" BY aep.policy_capability span=1h
```

---

## `session_id` / `run_id` → OTel trace/span ID mapping

OTel trace IDs are 128-bit (32 hex chars); AEP `run_id` is a UUID (36 chars including
dashes). The bridge strips dashes and takes the first 32 chars, right-padding shorter
IDs with `0`. This is a **deterministic, one-way mapping**: you can look up an AEP
`run_id` by searching for `aep.run_id = "<uuid>"` in your trace backend rather than
relying on the derived `traceId`.

OTel span IDs are 64-bit (16 hex chars); AEP `action_id` is also a UUID. Same rule
applies: first 16 chars of the UUID (after stripping dashes), right-padded with `0`.
