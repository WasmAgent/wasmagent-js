---
"@wasmagent/otel-exporter": patch
---

Add spanFromChatTurn() factory to @wasmagent/otel-exporter. Handles UUID→32/16-char hex conversion for traceId/spanId, hasError shorthand → OTLP status, and required OTLP field defaults (events: [], parentSpanId: undefined). Closes #306.
