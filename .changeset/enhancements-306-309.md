---
"@wasmagent/otel-exporter": minor
"@wasmagent/core": minor
"@wasmagent/aep": minor
"@wasmagent/react": minor
---

feat: four API enhancements (#306 #307 #308 #309)

- otel-exporter: add spanFromChatTurn() factory that builds a ReadableSpan from a chat-turn record, handling UUID to hex conversion, hasError shorthand, and all required OTLP defaults (#306)
- core: ObservationalMemory gains autoNote option (default true) to subscribe to assembler.addStep() events and call noteStep() automatically; MessageAssembler gains onStep() subscription API (#307)
- aep: buildToolRollups() returns typed ToolRollup[] with errorCount, errorRate, stateChangingCount, sideEffectClasses, avgDurationMs, p95DurationMs fields; ToolCallRollup kept for backward compatibility (#308)
- react: useAgentRun headers factory receives payload argument and is re-evaluated on every run() call so per-request values (panelSessionId, auth tokens) stay fresh (#309)
