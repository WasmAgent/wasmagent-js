/**
 * @deprecated VmKernel is the canonical name. V8WasmKernel will be removed in a future
 * major version. Migrate: `import { VmKernel } from "@agentkit-js/core"`.
 *
 * NOTE: Despite the "Wasm" in the name, this kernel uses node:vm — NOT WASM.
 * It is NOT a security boundary. See VmKernel for full documentation.
 */
export { VmKernel as V8WasmKernel } from "./VmKernel.js";
