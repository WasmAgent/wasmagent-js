/**
 * Recipe: WasmAgent + Mastra sandbox provider
 *
 * createMastraSandbox() implements Mastra's sandbox-provider contract —
 * execute(code, opts) -> { output } — backed by a WasmAgent kernel.
 * Wire the sandbox into a Mastra tool's execute handler, or assign it to
 * workspace.sandbox in a full Mastra Agent setup.
 *
 * Prerequisites:
 *   npm install @wasmagent/mastra-sandbox @wasmagent/kernel-quickjs \
 *     quickjs-emscripten @jitl/quickjs-wasmfile-release-sync
 *
 * Run:
 *   node index.mjs
 */
import { createMastraSandbox } from "@wasmagent/mastra-sandbox";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

// Create the sandbox — reuse across multiple execute() calls.
const sandbox = createMastraSandbox({
  kernel: new QuickJSKernel(),
  capabilities: {
    allowedHosts: [],       // no outbound network from sandboxed code
    cpuMs: 3000,            // 3 s CPU ceiling
    memoryLimitBytes: 64 * 1024 * 1024,
  },
});

// Direct execution — no model or API key needed.
const r1 = await sandbox.execute("1 + 2");
console.log("1+2 →", r1);

const r2 = await sandbox.execute(`
  const xs = [1, 2, 3, 4, 5];
  xs.reduce((a, b) => a + b, 0);
`);
console.log("sum →", r2);
