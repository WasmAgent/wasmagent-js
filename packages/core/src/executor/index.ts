export type {
  KernelResult,
  CapabilityManifest,
  WasmKernel,
  KernelEngine,
  ActionLanguage,
  KernelOptions,
} from "./types.js";
export { JsKernel } from "./JsKernel.js";
export { V8WasmKernel } from "./V8WasmKernel.js";
export { createKernel } from "./factory.js";
export {
  buildCapabilityGlobals,
  buildSandboxFetch,
  assertPathAllowed,
  matchGlob,
} from "./capabilities.js";

/**
 * PyodideKernel has moved to @agentkit-js/kernel-pyodide.
 * Re-exported here for backward compatibility.
 * Will be removed in a future major version.
 */
export type { WasmKernel as PyodideKernelInterface } from "./types.js";

