---
"@wasmagent/kernel-remote": patch
---

`RemoteSandboxKernel.runCommand()` now goes through the same fail-closed authority gate as `run()` (`#resolveAndAssertExecutionPolicy`): restrictive capability merge, rejection of unenforceable restrictions, and the `allowUnrestrictedNetwork` / `allowUnrestrictedSandboxFs` acknowledgments — all BEFORE the sandbox is allocated. New optional per-call `capabilities` parameter; per-call `cpuMs` now narrows the command timeout like it does for `run()`. Hostile regression tests RC01–RC08 pin the gate (default-deny, single-flag rejection, constructor-ceiling bypass attempts, no sandbox allocation on rejected policy, timeout narrowing).
