---
"@wasmagent/kernel-wasmtime": minor
"@wasmagent/core": patch
---

feat(kernel-wasmtime): deterministic fuel metering, epoch interruption, and memory limits (#34, #35, #36)

Adds three resource-limit capabilities to WasmtimeKernel:

- **Fuel metering (#34)**: When `fuelLimit` is set, the compiled WASM binary is
  instrumented with gas counters via `@seda-protocol/wasm-metering-ts`. Each
  basic block deducts from an i64 fuel global; execution traps with
  `FuelExhausted` when the budget is spent.

- **Epoch cooperative interruption (#35)**: A configurable `epochTickMs` timer
  checks elapsed wall-clock time against the deadline. Combined with fuel
  metering, this provides defence-in-depth against runaway execution.

- **Memory growth limit (#36)**: When `maxMemoryBytes` is set, the WASM memory
  section is rewritten to enforce a `maximum` page count. `memory.grow` returns
  -1 if the guest exceeds the cap.

The `KernelOptions` interface in `@wasmagent/core` is extended with `fuelLimit`,
`maxMemoryBytes`, and `epochTickMs` fields (all optional, backward-compatible).
