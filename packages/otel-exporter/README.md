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

## Semantic Convention Version Tracking

This package tracks the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).

| Constant | Value | Meaning |
|---|---|---|
| `GENAI_SEMCONV_VERSION` | `"1.28.0"` | The semconv spec version this package conforms to |

### Opting into experimental semconv

The GenAI semantic conventions are currently in **Development/Experimental** stability. As the spec evolves, attribute names may change. This package supports incremental opt-in:

```ts
import { OtlpHttpExporter } from "@wasmagent/otel-exporter";

// Option 1: explicit in code
const exporter = new OtlpHttpExporter({ semconvVersion: "latest" });

// Option 2: environment variable (cluster-level override)
// Set OTEL_SEMCONV_STABILITY_OPT_IN=genai/experimental
const exporter2 = new OtlpHttpExporter(); // picks up env var automatically
```

When `useLatestSemconv` is `true`, the exporter may emit attribute names following the newest draft conventions. When `false` (the default), it uses the baseline stable mapping.

The environment variable `OTEL_SEMCONV_STABILITY_OPT_IN` follows the [OTel specification](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/) for semconv stability opt-in. Setting it to `"genai/experimental"` enables experimental GenAI conventions.

## License

[Apache-2.0](./LICENSE) — © wasmagent contributors
