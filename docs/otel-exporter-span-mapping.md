# `@wasmagent/otel-exporter` — AEP → OTel Span Mapping

This document is the authoritative mapping between AEP record fields and the
OpenTelemetry span attributes emitted by `@wasmagent/otel-exporter`.

Source: `packages/otel-exporter/src/aep-otel-bridge.ts`,
`packages/otel-exporter/src/aep-span-names.ts`

---

## Span name convention

AEP action evidence is emitted with the **current** OTel GenAI semantic
conventions shape:

- Span name: **`execute_tool {gen_ai.tool.name}`** (e.g. `execute_tool read_file`)
- `gen_ai.operation.name = execute_tool`

The legacy WasmAgent shape (span name `tool.call`, `AEP_SPAN_NAMES.TOOL_CALL`)
is still **read** for import compatibility, but is no longer emitted.

---

## AEP field → OTel span attribute mapping

### Current GenAI standard attributes

| AEP field | OTel attribute | Type | Notes |
|---|---|---|---|
| `actions[].tool_name` | `gen_ai.tool.name` | string | Core identity of the executed tool |
| `actions[].action_id` | `gen_ai.tool.call.id` | string | Full action id (the span id is its first 16 chars) |
| (constant) | `gen_ai.operation.name` | string | Always `execute_tool` for action evidence |

### AEP extension attributes (`aep.*`)

The `aep.*` namespace travels alongside the standard attributes; standard-only
consumers can ignore it, AEP-aware consumers use it to recover the full record.

| AEP field | OTel attribute | Type | Notes |
|---|---|---|---|
| `actions[].tool_name` | `aep.tool_name` | string | Mirror of `gen_ai.tool.name` |
| `actions[].state_changing` | `aep.state_changing` | boolean | Only emitted when the record asserts it |
| `run_id` | `aep.run_id` | string | Also stored as a span attribute for SIEM query |
| `actions[].causal_chain_id` | `aep.causal_chain_id` | string | |
| `actions[].scope_lease_id` | `aep.scope_lease_id` | string | |
| `actions[].result_digest` | `aep.result_digest` | string | |
| `actions[].pre_state_digest` | `aep.pre_state_digest` | string | |
| `actions[].post_state_digest` | `aep.post_state_digest` | string | |
| `capability_decisions[].decision` | `aep.policy_decision` | string (`allow`/`deny`/`ask_user`/`dry_run`) | |
| `capability_decisions[].capability` | `aep.policy_capability` | string | |
| `capability_decisions[].reason_code` | `aep.policy_reason_code` | string | |
| `actions[].input_taint_labels` | `aep.input_taint_labels` | string[] | |
| `actions[].output_taint_labels` | `aep.output_taint_labels` | string[] | |

### Identity and tracing

| AEP field | OTel attribute | Type | Notes |
|---|---|---|---|
| `actions[].action_id` | `spanId` | string (16 hex chars) | First 16 chars of action_id, right-padded with `0` |
| `actions[].parent_action_id` | `parentSpanId` | string (16 hex chars) | Same padding rule |
| `run_id` | `traceId` | string (32 hex chars) | First 32 chars of run_id, right-padded |
| `actions[].timestamp_ms` | `startTimeUnixNano` | number | `timestamp_ms * 1_000_000` |

---

## Reverse mapping: OTel span → AEP action (lossy)

`otelSpanToAepAction()` imports tool-execution spans into AEP-shaped objects.
It recognizes **two** span shapes:

| Shape | Recognition rule |
|---|---|
| Current GenAI | `gen_ai.operation.name = "execute_tool"` **and** `gen_ai.tool.name` present (matches `execute_tool` and `execute_tool <tool>` span names, with or without `aep.*` attrs) |
| Legacy WasmAgent | span name `tool.call` **and** `aep.tool_name` present |

Anything else — including chat-completion spans — returns `null`.

### What is honest absence, not a default

The reverse mapping is **lossy by design**. Fields a span cannot assert are
left **absent**, and absence means *unknown*:

- No `aep.state_changing` on the span → the imported action has **no**
  `state_changing` value. It is never coerced to `false`: "unknown" must not
  be upgraded to "known non-mutating".
- Partial `aep.policy_*` attributes → **no** `capability_decision` is
  constructed. A full decision requires decision, capability, subject and
  resource; partial information is dropped rather than padded with empty
  strings into a plausible-looking decision.

Fields recoverable from `aep.*` extensions (chain id, digests, taint labels,
full capability decisions) import when present and stay absent when not.

### Authenticity boundary

An OTel span imported through this bridge is **not authenticated AEP
evidence**:

- it does **not** inherit DSSE authenticity,
- it is **not** signed by the conversion,
- it does **not** establish AEP semantic completeness.

If you need a canonical AEP record, create it through the normal emitter path
and mark it as derived from OTel telemetry. The import exists for
audit/training pipelines that can tolerate lossy, unauthenticated input.

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
