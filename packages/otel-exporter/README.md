# /otel-exporter

> **Maturity: alpha** — may change without notice; production use at your own risk.

OpenTelemetry exporter — wire wasmagent `EventLog` into Jaeger / Tempo / any OTLP collector.

> Part of [wasmagent](https://github.com/WasmAgent/wasmagent-js) — a TypeScript + WASM agent runtime.

## Stability: beta

This package is in **beta**. The span schema and attribute names may change in minor releases
as the OpenTelemetry semantic conventions for AI agents stabilise.

## Install

```bash
npm install /otel-exporter /core
```

## Usage

Bridges agent events (model calls, tool calls, kernel executions) to OTLP traces with
correct parent/child span relationships. See `examples/otel-jaeger`.

## License

[Apache-2.0](./LICENSE) — © wasmagent contributors
