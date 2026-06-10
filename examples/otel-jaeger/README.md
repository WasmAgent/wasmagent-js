# otel-jaeger — End-to-end OpenTelemetry trace pipeline

Spin up Jaeger locally and export agentkit-js traces to it. Useful for
visualizing agent runs, debugging slow steps, and measuring tool
latency distributions.

## Quick start

```bash
# 1. Start Jaeger
docker compose up -d
# UI: http://localhost:16686
# OTLP endpoint: http://localhost:4318

# 2. Run an agent with OTEL export enabled
export ANTHROPIC_API_KEY=...
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
bun run start
```

## What you'll see

The Jaeger UI shows a hierarchical trace tree:

```
invoke_agent (35s)
├── agent.step.0 (1.2s)
│   ├── execute_tool (web_search)  450ms
│   └── model.generate              800ms
├── agent.step.1 (2.4s)
│   ├── execute_tool (read_file)    50ms
│   ├── execute_tool (read_file)    60ms  ← parallel via DAG scheduler
│   └── model.generate              2.2s
└── agent.step.2 (700ms)
    └── model.generate              700ms
```

Each span carries:
- Standard `gen_ai.*` attributes (input tokens, output tokens, cache
  read tokens, model name, request id)
- agentkit-specific attributes (step index, tool name, error code)

## Sampling, redaction, baggage

The OTEL exporter ships three composable extensions you can wire in:

```ts
import {
  OtlpHttpExporter,
  ProbabilisticSampler,
  TraceRedactor,
  extractBaggage,
} from "@agentkit-js/otel-exporter";

const sampler = new ProbabilisticSampler(0.1);     // 10% of traces
const redactor = new TraceRedactor();              // PII out
const baggage = extractBaggage(request);           // {user-id, tenant, ...}

const exporter = new OtlpHttpExporter({
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT!,
});
```

See the [`@agentkit-js/otel-exporter` README](../../packages/otel-exporter/)
for full API.

## Cleanup

```bash
docker compose down -v
```
