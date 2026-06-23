/**
 * D5 — StackBlitz-runnable demo: Mastra sandbox provider backed by an
 * WasmAgent QuickJS kernel.
 *
 * Mastra's sandbox-provider contract takes any object that implements
 * `execute(code, opts) -> { output }`. WasmAgent's `createMastraSandbox`
 * returns exactly that, with the same `CapabilityManifest` you'd use
 * everywhere else in WasmAgent.
 *
 * The script demonstrates the contract directly — wiring it into Mastra's
 * `Agent` follows the standard Mastra `workspace.sandbox` slot once you
 * have `@mastra/core` installed.
 */
import { createMastraSandbox } from "@wasmagent/mastra-sandbox";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const sandbox = createMastraSandbox({
  kernel: new QuickJSKernel(),
  capabilities: { cpuMs: 3000 },
});

const r1 = await sandbox.execute("1 + 2");
console.log("1+2 →", r1);

const r2 = await sandbox.execute(`
  const xs = [1,2,3,4,5];
  xs.reduce((a,b) => a+b, 0);
`);
console.log("sum →", r2);
