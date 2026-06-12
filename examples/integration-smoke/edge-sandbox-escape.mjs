/**
 * Edge integration smoke: sandbox escape vectors.
 *
 * Both kernels evaluate scripts in expression-mode: the LAST expression's
 * value is the kernel's `output`. We wrap multi-statement vectors in IIFEs.
 *
 * For each kernel + each known escape pattern, assert that the kernel
 * either rejects the script outright OR — if it executes — produces a
 * value that proves the host process was NOT reached.
 *
 * Run: `bun edge-sandbox-escape.mjs` from this directory.
 */
import { JsKernel } from "@agentkit-js/core";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";

let failed = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log(`✓ ${label}`);
  } else {
    console.error(`✗ ${label}`, detail ?? "");
    failed++;
  }
}

const KERNELS = [
  { name: "JsKernel", make: () => new JsKernel({ timeoutMs: 2_000 }) },
  { name: "QuickJSKernel", make: () => new QuickJSKernel({ timeoutMs: 2_000 }) },
];

// Mark something on the host process. If a script reads it back, the
// sandbox boundary failed.
process.env.HOSTSECRET = "REACHED_HOST_PROCESS";

// IIFE wrapper helper: lets us write multi-statement vectors and still
// produce a single expression value.
const iife = (body) => `(function(){ ${body} })()`;
const aiife = (body) => `(async function(){ ${body} })()`;

const VECTORS = [
  {
    label: "process is undefined",
    code: "typeof process",
    expectOutput: "undefined",
  },
  {
    label: "globalThis.process is undefined",
    code: "typeof globalThis.process",
    expectOutput: "undefined",
  },
  {
    label: "require is undefined",
    code: "typeof require",
    expectOutput: "undefined",
  },
  {
    label: "Function constructor cannot reach process",
    code: iife(`
      try {
        var f = (function(){}).constructor("return typeof process");
        return f();
      } catch (e) { return "blocked"; }
    `),
    assertOutput: (v) => v === "undefined" || v === "blocked",
  },
  {
    label: "AsyncFunction constructor cannot reach process",
    // AsyncFunction returns a Promise — the kernel awaits the IIFE's
    // returned Promise (see JsKernelWorker / QuickJSKernel).
    code: aiife(`
      try {
        var A = (async function(){}).constructor;
        var f = A("return typeof process");
        return await f();
      } catch (e) { return "blocked"; }
    `),
    assertOutput: (v) => v === "undefined" || v === "blocked",
  },
  {
    label: "GeneratorFunction constructor cannot reach process",
    code: iife(`
      try {
        var G = (function*(){}).constructor;
        var f = G("yield typeof process");
        return f().next().value;
      } catch (e) { return "blocked"; }
    `),
    assertOutput: (v) => v === "undefined" || v === "blocked",
  },
  {
    label: "globalThis has no host modules",
    code: iife(`
      var keys = Object.keys(globalThis);
      var dangerous = keys.filter(function(k){
        return /^(process|require|fs|child_process|http|https|net|module|__dirname|__filename|Buffer)$/.test(k);
      });
      return dangerous.length === 0 ? "clean" : "LEAKED:" + dangerous.join(",");
    `),
    expectOutput: "clean",
  },
  {
    label: "Error.prepareStackTrace override does not leak host frames",
    code: iife(`
      try {
        Error.prepareStackTrace = function(e, frames) {
          return frames.map(function(f){
            return f && f.getFunction ? typeof f.getFunction : "no-getFunction";
          });
        };
        var e = new Error("x");
        var s = e.stack;
        // s should be either a string (no-op) or an array of strings (no leak).
        // What it MUST NOT contain is the host's "process.env.HOSTSECRET"
        // value — JsKernel runs in worker_threads and the host env is gone.
        var serialised = typeof s === "string" ? s : JSON.stringify(s || []);
        return serialised.indexOf("REACHED_HOST_PROCESS") === -1 ? "no-host-leak" : "LEAKED";
      } catch (e) { return "blocked"; }
    `),
    expectOutput: "no-host-leak",
  },
  {
    label: "regex catastrophic backtracking is bounded by cpuMs",
    code: `/(a+)+$/.test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!")`,
    cap: { cpuMs: 200 },
    assertResolution: (out, err) =>
      // Either it returns false fast OR it hits the cpuMs deadline. NOT
      // allowed: hang past cpuMs without rejecting.
      err != null || out === false,
  },
  {
    label: "JSON.stringify cannot pull host objects via toJSON tricks",
    code: iife(`
      var x = { toJSON: function(){ return typeof process; } };
      return JSON.parse(JSON.stringify(x));
    `),
    expectOutput: "undefined",
  },
  {
    label: "this at top level is not the host global",
    // In strict / module mode this is undefined; in script mode this is the
    // sandbox global. NEVER the Node global with `process`.
    code: iife(`
      var t = (function(){ return this; }).call(null);
      return t == null ? "null-this" : (typeof t.process === "undefined" ? "no-host" : "LEAKED");
    `),
    assertOutput: (v) => v === "null-this" || v === "no-host",
  },
  {
    label: "constructor.constructor chain via array literal does not escape",
    // Classic CTF vector: `[].constructor.constructor("alert(1)")()`.
    code: iife(`
      try {
        var f = [].constructor.constructor("return typeof process");
        return f();
      } catch (e) { return "blocked"; }
    `),
    assertOutput: (v) => v === "undefined" || v === "blocked",
  },
  {
    label: "Symbol.iterator on host bridge does not expose internals",
    // If __fs__ is granted (it isn't here), it must not be iterable in a
    // way that exposes more than the documented {readFile, writeFile} pair.
    code: iife(`
      return typeof __fs__ === "undefined" ? "no-fs-without-cap" : Object.keys(__fs__).sort().join(",");
    `),
    expectOutput: "no-fs-without-cap",
  },
];

async function runVector(name, kernelMake, vec) {
  const kernel = kernelMake();
  let out, err;
  try {
    const r = await kernel.run(vec.code, vec.cap);
    out = r.output;
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  } finally {
    await kernel[Symbol.asyncDispose]?.();
  }

  const label = `[${name}] ${vec.label}`;
  if (vec.assertResolution) {
    assert(label, vec.assertResolution(out, err), { out, err });
  } else if (vec.assertOutput) {
    assert(label, err == null && vec.assertOutput(out), { out, err });
  } else {
    assert(label, err == null && out === vec.expectOutput, { out, err });
  }
}

for (const { name, make } of KERNELS) {
  for (const vec of VECTORS) {
    await runVector(name, make, vec);
  }
}

if (failed > 0) {
  console.error(`\n[edge-sandbox-escape] ${failed} VECTOR(S) FAILED`);
  process.exit(1);
}
console.log(
  `\n[edge-sandbox-escape] all ${VECTORS.length * KERNELS.length} vectors passed across ${KERNELS.length} kernels`
);
