# /ag-ui

AG-UI (inbound) HTTP transport for wasmagent agents — frame protocol + streaming.

> Part of [wasmagent](https://github.com/WasmAgent/wasmagent-js) — a TypeScript + WASM agent runtime.

## Install

```bash
npm install @wasmagent/ag-ui @wasmagent/core
```

## Usage

Expose any agent over the [AG-UI](https://github.com/ag-ui-protocol/ag-ui) frame protocol so
front-ends and agent IDEs can drive runs over a standard transport.

### Event mapping

| `AgentEvent` | AG-UI event(s) emitted |
|---|---|
| `run_start` | `RUN_STARTED` |
| `step_start` | `THINKING_END` (if thinking active) + `STEP_STARTED` |
| `thinking_delta` | `THINKING_START` (first delta only) + `TEXT_MESSAGE_CHUNK` (channel: thinking) |
| `tool_call` | `THINKING_END` (if active) + `TOOL_CALL_START` + `TOOL_CALL_ARGS` |
| `tool_result` | `TOOL_CALL_RESULT` + `TOOL_CALL_END` |
| `planning` | `TEXT_MESSAGE_CHUNK` (channel: planning) |
| `final_answer` | `THINKING_END` (if active) + `TEXT_MESSAGE_START` + `TEXT_MESSAGE_CONTENT` + `TEXT_MESSAGE_END` + `RUN_FINISHED` |
| `error` | `THINKING_END` (if active) + `RUN_ERROR` |
| `await_human_input` | `STATE_DELTA` (pendingApproval) + `STEP_FINISHED` |
| `guardrail_tripwire` | `RUN_ERROR` |
| everything else | `RAW` |

### RunAgentInput extensions

Beyond the standard AG-UI fields, `fromRunAgentInput()` supports:

- **`resume`** (`true` | `string`) — Resume a prior session from KV. `true` uses `threadId`; a string value is used directly as the session key.
- **`context`** (`Record<string, unknown>[]`) — Structured context items injected as a `<context>` block appended to the agent task.
- **`parentRunId`** — Passed through for nested-run tracing.

### Type alignment

Event types are local mirrors of `@ag-ui/core 0.0.57`. The package does not take a runtime
dependency on the official npm package (alpha stability), but maintains type compatibility.
When the official package reaches stable, a future release will switch to imported types.

## License

[Apache-2.0](./LICENSE) — © wasmagent contributors
