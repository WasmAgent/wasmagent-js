---
"@wasmagent/compliance": major
"@wasmagent/core": major
---

Consume canonical AEP + compliance schemas from `@wasmagent/protocol` instead of local copies.

**Breaking:** the schema subpath exports are removed:
- `@wasmagent/compliance/schemas/{constraint-ir,constraint-violation,repair-trace,task-spec,compliance-eval-record}`
- `@wasmagent/core/schemas/rollout-wire`

Import these from `@wasmagent/protocol/schemas/...` instead — a single canonical source (see WasmAgent/wasmagent-protocol). `@wasmagent/core/schemas/training-record` is unchanged (core-private).
