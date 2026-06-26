---
"@wasmagent/kernel-wasmtime": patch
---

Use fileURLToPath for cross-platform path resolution in WasmtimeKernel.test.ts. Previous implementation used manual replace("file://", "") which produced invalid /C:/... paths on Windows.
