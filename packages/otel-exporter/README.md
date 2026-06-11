# @agentkit-js/otel-exporter

OpenTelemetry exporter — wire agentkit-js `EventLog` into Jaeger / Tempo / any OTLP collector.

> Part of [agentkit-js](https://github.com/telleroutlook/agentkit-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @agentkit-js/otel-exporter @agentkit-js/core
```

## Usage

Bridges agent events (model calls, tool calls, kernel executions) to OTLP traces with
correct parent/child span relationships. See `examples/otel-jaeger`.

## License

[Apache-2.0](./LICENSE) — © agentkit-js contributors
