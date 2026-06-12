/**
 * Edge integration smoke: kernel state pollution + concurrency.
 *
 * Code-mode lives or dies on per-call isolation. The unit tests cover one
 * `run()` at a time; this script drives sequences and overlaps to catch
 * the kind of bugs that only appear when state crosses calls:
 *
 *   - Sequential capability churn: cap → no-cap → different cap. Globals
 *     must not leak between runs.
 *   - reset() really clears user state.
 *   - Two concurrent run() calls on the same kernel must not corrupt each
 *     other's logs / final-answer sentinels / output.
 *   - dispose() then run() should error cleanly, not crash the host.
 *   - Global mutation persists across runs ONLY when the same kernel is
 *     reused without reset() — which is the documented "stateful kernel"
 *     contract.
 */
import { JsKernel } from "@agentkit-js/core";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";

let failed = 0;
function ok(label) {
  console.log(`✓ ${label}`);
}
function fail(label, detail) {
  console.error(`✗ ${label}`, detail ?? "");
  failed++;
}

const KERNELS = [
  { name: "JsKernel", make: () => new JsKernel({ timeoutMs: 2_000 }) },
  { name: "QuickJSKernel", make: () => new QuickJSKernel({ timeoutMs: 2_000 }) },
];

for (const { name, make } of KERNELS) {
  // 1. Capability churn: setting then clearing must really clear globals.
  {
    const k = make();
    try {
      const r1 = await k.run("typeof fetch", { allowedHosts: ["a.example"] });
      if (r1.output !== "function") fail(`[${name}] capability set: typeof fetch`, r1);
      else ok(`[${name}] capability set: typeof fetch === function`);

      const r2 = await k.run("typeof fetch");
      if (r2.output !== "undefined") fail(`[${name}] capability clear: typeof fetch leaked`, r2);
      else ok(`[${name}] capability clear: fetch is gone`);

      const r3 = await k.run("typeof fetch", { allowedHosts: ["b.example"] });
      if (r3.output !== "function") fail(`[${name}] capability re-set after clear`, r3);
      else ok(`[${name}] capability re-set after clear`);
    } finally {
      await k[Symbol.asyncDispose]?.();
    }
  }

  // 2. Stateful kernel: globals persist across runs unless reset().
  {
    const k = make();
    try {
      await k.run("globalThis.__counter__ = (globalThis.__counter__ || 0) + 1");
      await k.run("globalThis.__counter__ = (globalThis.__counter__ || 0) + 1");
      const r = await k.run("globalThis.__counter__");
      if (r.output !== 2) fail(`[${name}] stateful kernel: counter`, r);
      else ok(`[${name}] stateful kernel: globals persist`);

      await k.reset();
      const r2 = await k.run("typeof globalThis.__counter__");
      if (r2.output !== "undefined") fail(`[${name}] reset() did not clear globals`, r2);
      else ok(`[${name}] reset() clears user globals`);
    } finally {
      await k[Symbol.asyncDispose]?.();
    }
  }

  // 3. Concurrent run() on the same kernel — must not interleave logs or
  //    final-answer sentinels. Both kernels are documented as serialising
  //    calls; this asserts that contract.
  {
    const k = make();
    try {
      const a = k.run("(function(){ console.log('A'); return 1; })()");
      const b = k.run("(function(){ console.log('B'); return 2; })()");
      const [ra, rb] = await Promise.all([a, b]);
      // Each result's own logs should match its own output.
      const aOk = ra.output === 1 && ra.logs.includes("A") && !ra.logs.includes("B");
      const bOk = rb.output === 2 && rb.logs.includes("B") && !rb.logs.includes("A");
      if (!aOk) fail(`[${name}] concurrent: run A's logs polluted by B`, ra);
      else if (!bOk) fail(`[${name}] concurrent: run B's logs polluted by A`, rb);
      else ok(`[${name}] concurrent run(): no log/output crosstalk`);
    } finally {
      await k[Symbol.asyncDispose]?.();
    }
  }

  // 4. dispose() then run() — must error cleanly, not crash.
  {
    const k = make();
    await k.run("1");
    await k[Symbol.asyncDispose]();
    let errMsg = "";
    try {
      await k.run("1");
      fail(`[${name}] run() after dispose() must throw`);
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
      ok(`[${name}] run() after dispose() throws: ${errMsg.slice(0, 50)}`);
    }
  }

  // 5. final-answer sentinel from one run does not bleed into the next.
  {
    const k = make();
    try {
      const r1 = await k.run("__finalAnswer__ = 'first'; null");
      if (!r1.isFinalAnswer || r1.output !== "first") {
        fail(`[${name}] sentinel set but not picked up`, r1);
      } else {
        ok(`[${name}] sentinel: first call sets isFinalAnswer`);
      }
      const r2 = await k.run("42");
      if (r2.isFinalAnswer) fail(`[${name}] sentinel leaked to next run`, r2);
      else ok(`[${name}] sentinel does not leak across runs`);
    } finally {
      await k[Symbol.asyncDispose]?.();
    }
  }

  // 6. env from previous run does NOT survive when the next run omits env.
  //    This is the same property cross-kernel.mjs checks, but here paired
  //    with surrounding capability changes to catch ordering bugs.
  {
    const k = make();
    try {
      await k.run("typeof __env__", { env: { K: "v" } });
      await k.run("typeof __env__", { allowedHosts: ["x.example"] }); // no env this round
      const r = await k.run("typeof __env__");
      if (r.output !== "undefined") fail(`[${name}] env survived after capability change`, r);
      else ok(`[${name}] env eviction after intervening capability change`);
    } finally {
      await k[Symbol.asyncDispose]?.();
    }
  }
}

if (failed > 0) {
  console.error(`\n[edge-state-pollution] ${failed} CHECK(S) FAILED`);
  process.exit(1);
}
console.log(`\n[edge-state-pollution] all checks passed`);
