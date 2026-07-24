---
"@wasmagent/core": patch
---

Enforce `memoryLimitBytes` / `maxMemoryBytes` in `JsKernel` (the default kernel) as a hard V8 heap cap via `node:worker_threads` `resourceLimits` (issue #192). Previously these fields were advisory in `JsKernel`; a runaway allocation could exhaust the host heap. The cap is applied at worker spawn (constructor-level only, since a live worker's heap limit cannot be resized between `run()` calls), and a worker that aborts on FATAL OOM now surfaces as a `run()` rejection instead of silently timing out. Also exports a `memoryBytesToResourceLimits(bytes)` helper.
