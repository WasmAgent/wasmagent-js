---
"@wasmagent/aep": minor
---

feat(aep): capture tool outcome, exit code, and arguments digest in addAction (#163)

- `ActionEvidence` gains three optional fields — `outcome`, `exit_code`, and `arguments_digest` — so `AEPEmitter.addAction()` can capture the full tool-call evidence set: tool name, outcome, exit code, arguments hash, and result hash (`result_digest`). Fields are optional and backward compatible; existing records and callers are unaffected.
