---
"@wasmagent/core": minor
---

Cross-kernel constructor capability ceiling (K01–K12 contract) + merge-semantics fixes.

- `JsKernel`, `VmKernel` now store the constructor `capabilities` as a frozen immutable authority ceiling and route every `run()` through `resolveEffectiveCapabilities(base, call)`; `QuickJSKernel` and `WasmtimeKernel` do the same via their existing `KernelOptions.capabilities`. After the merge, execution paths consult only the effective manifest — per-call manifests may narrow the ceiling, never widen it.
- `resolveEffectiveCapabilities` omission semantics fixed: an ABSENT axis on one side no longer intersects to an empty set. List axes and env now treat omission as "no constraint from this side" (the other side's value stands); explicit `[]` remains deny-all. Previously a provider with no constructor env silently dropped every per-call env key.

New `capabilities.contract.test.ts` pins the merge matrix (K01–K12).
