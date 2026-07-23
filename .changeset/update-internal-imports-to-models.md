---
"@wasmagent/cli": patch
"@wasmagent/evals-runner": patch
"@wasmagent/model-local": patch
---

Update imports to use `@wasmagent/models` instead of `@wasmagent/core`

Internal import path change only — no public API change. Adapter classes
(`AnthropicModel`, `OpenAIModel`, `GenericOpenAICompatModel`, `FallbackModel`)
moved to `@wasmagent/models` as part of the #123 extraction.
