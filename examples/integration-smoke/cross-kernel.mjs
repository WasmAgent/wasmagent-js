/**
 * Cross-kernel integration smoke — same `CapabilityManifest` produces the
 * same observable surface in JsKernel and QuickJSKernel. This is the
 * cross-kernel contract A1 added; the in-package unit tests exercise
 * each kernel separately, but this smoke runs both side-by-side with the
 * exact same manifest to catch drift.
 */
import { JsKernel } from "@agentkit-js/core";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";

function check(label, cond, detail) {
  if (!cond) {
    console.error(`[X] ✗ ${label}`, detail ?? "");
    process.exit(1);
  }
  console.log(`[X] ✓ ${label}`);
}

const KERNELS = [
  { name: "JsKernel", k: () => new JsKernel({ timeoutMs: 3_000 }) },
  { name: "QuickJSKernel", k: () => new QuickJSKernel({ timeoutMs: 3_000 }) },
];

for (const { name, k } of KERNELS) {
  const kernel = k();
  try {
    // 1. allowedHosts: undefined fetch when no host granted, function when granted
    const r1 = await kernel.run("typeof fetch");
    check(`${name}: fetch undefined without allowedHosts`, r1.output === "undefined", r1);

    const r2 = await kernel.run("typeof fetch", { allowedHosts: ["api.example.com"] });
    check(`${name}: fetch=function with allowedHosts`, r2.output === "function", r2);

    // 2. env: __env__ visibility
    const r3 = await kernel.run("typeof __env__");
    check(`${name}: __env__ undefined without env`, r3.output === "undefined", r3);

    const r4 = await kernel.run("__env__.K", { env: { K: "v" } });
    check(`${name}: __env__.K === 'v'`, r4.output === "v", r4);

    // env from one run must not leak into the next
    const r5 = await kernel.run("typeof __env__");
    check(`${name}: __env__ does not leak across runs`, r5.output === "undefined", r5);

    // 3. cpuMs: tightens kernel default
    let timedOut = false;
    try {
      await kernel.run("while(true){}", { cpuMs: 100 });
    } catch (e) {
      timedOut = e instanceof Error && /timed out/.test(e.message);
    }
    check(`${name}: cpuMs=100 enforced`, timedOut);
  } finally {
    await kernel[Symbol.asyncDispose]?.();
  }
}

console.log("\n[X] all cross-kernel capability checks passed");
process.exit(0);
