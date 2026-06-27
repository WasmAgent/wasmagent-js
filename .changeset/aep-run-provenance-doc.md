---
"@wasmagent/aep": patch
---

docs(aep): describe run-provenance fields (repo_commit, runtime_version, policy_bundle_digest, tool_manifest_digest) and how downstream consumers anchor a record back to the code, runtime, policy ruleset and tool manifest in effect at run time. Adds an explicit regression test that pins the constructor → record transport for the four fields and confirms they are inside the signed payload.

Refs: WasmAgent/wasmagent-js#12
