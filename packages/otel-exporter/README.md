# /otel-exporter

OpenTelemetry exporter — wire wasmagent `EventLog` into Jaeger / Tempo / any OTLP collector.

> Part of [wasmagent](https://github.com/WasmAgent/wasmagent-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install /otel-exporter /core
```

## Usage

Bridges agent events (model calls, tool calls, kernel executions) to OTLP traces with
correct parent/child span relationships. See `examples/otel-jaeger`.

## License

[Apache-2.0](./LICENSE) — © wasmagent contributors
