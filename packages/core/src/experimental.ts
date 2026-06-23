// @wasmagent/core/experimental — APIs that may change or be removed at any time.
// No stability promise. Use only when you can absorb breaking changes.

// Observability (OTel bridge)
export type {
  GenAiMetricPoint,
  MetricExporter,
  OtelBridgeOptions,
  ReadableSpan,
  SpanAttributes,
  SpanExporter,
} from "./observability/index.js";
export { InMemorySpanExporter, OtelBridge, withOtel } from "./observability/index.js";
