---
"@wasmagent/kernel-remote": patch
"@wasmagent/cli": patch
"@wasmagent/react": patch
---

fix(kernel-remote): harness now checks `__finalAnswer__`/`__final_answer__` sentinel variables, matching QuickJS/JS kernel behavior

fix(cli): devtools server `listen()` now rejects on port-bind errors instead of hanging indefinitely

fix(cli): `parseCrosswalkYaml` validates all required fields (id, risk, priority) before pushing entries

fix(react): `useAgentRun` removes stale `status` from useCallback deps, uses `receivedFinalAnswer` flag for idle fallback
