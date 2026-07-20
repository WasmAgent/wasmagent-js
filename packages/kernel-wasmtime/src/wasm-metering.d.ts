/**
 * Type declarations for @seda-protocol/wasm-metering-ts.
 *
 * The package ships untyped JavaScript (no .d.ts). We declare the subset of
 * the API used by WasmtimeKernel here.
 */
declare module "@seda-protocol/wasm-metering-ts" {
  /**
   * Instrument a WASM binary with gas metering.
   *
   * @param wasm - The WebAssembly binary (Buffer or Uint8Array).
   * @param costTable - Cost table specifying per-opcode gas costs and memory limits.
   * @returns The instrumented WASM binary with metering globals exported.
   *
   * The instrumented module exports:
   *   - `metering_remaining_points` (global i64): gas budget, set by host before run.
   *   - `metering_points_exhausted` (global i32): set to 1 if fuel runs out.
   */
  export function meterWasm(wasm: Buffer | Uint8Array, costTable: Record<string, unknown>): Buffer;
}
