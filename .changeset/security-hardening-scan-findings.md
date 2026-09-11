---
"@wasmagent/cli": patch
"@wasmagent/cloudflare-worker": patch
"@wasmagent/evals-runner": patch
"@wasmagent/mcp-server": patch
"@wasmagent/aisdk": patch
"@wasmagent/model-local": patch
---

Security hardening from the sealed security-scan findings: safe arithmetic evaluator replaces `Function()` in the basic-agent example; output paths from CLI arguments are validated (NUL/control characters rejected, resolved) before writes; OpenAI-compatible eval provider refuses non-https endpoints except loopback; client-supplied event-log trace ids are constrained to a safe charset; MCP `run_agent` task strings get a hard length cap; the D1 `exec` interface member is declared as a property signature.
