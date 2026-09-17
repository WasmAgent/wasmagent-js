---
"@wasmagent/otel-exporter": minor
---

Align the AEP ↔ OTel bridge with the current OTel GenAI semantic conventions (`execute_tool`).

**Emission** (`aepActionToOtelSpan`): action-evidence spans are now named
`execute_tool <gen_ai.tool.name>` (previously `tool.call`) and carry the current
standard attributes `gen_ai.operation.name = execute_tool`, `gen_ai.tool.name`
and `gen_ai.tool.call.id`, alongside the existing `aep.*` extension attributes.
`aep.state_changing` is only emitted when the record actually asserts it.
The `toolCallSpanAttrs` helper now emits `gen_ai.tool.name` / `gen_ai.tool.type`
instead of the old `tool.*` keys.

**Import** (`otelSpanToAepAction`): recognizes current third-party GenAI spans
(`gen_ai.operation.name = execute_tool` + `gen_ai.tool.name`) in addition to the
legacy `tool.call` + `aep.tool_name` shape. Honest-absence semantics: a missing
`aep.state_changing` imports as absent (unknown), never `false`; a
`capability_decision` is only built when decision, capability, subject and
resource are all present. Imported spans are unauthenticated telemetry and do
not inherit DSSE authenticity.
