/**
 * codemodeExecutor.test.ts — coverage for the Cloudflare codemode adapter.
 *
 * The cloudflare codemode `Executor` contract is one method:
 *
 *   execute(code, providersOrFns) => Promise<{ result, error?, logs? }>
 *
 * Tests pin: (a) flat-Record fn surface, (b) namespaced ResolvedProvider[]
 * surface, (c) positional vs object args, (d) console.log capture,
 * (e) tool throws are surfaced, (f) unknown tool name fails fast,
 * (g) maxIterations bounds runaway scripts, (h) runtime errors
 * (syntax / ReferenceError / TypeError), (i) blocked host access,
 * (j) kernel disposal, (k) infinite loops via kernel timeout.
 *
 * We use `JsKernel` for speed (no WASM init); the executor itself is
 * kernel-agnostic — replacing JsKernel with QuickJSKernel should be
 * orthogonal to these tests.
 */

import { JsKernel } from "@wasmagent/core";
import { createCodemodeExecutor } from "./codemodeExecutor.js";

describe("createCodemodeExecutor — construction", () => {
  it("rejects missing opts", () => {
    expect(() => createCodemodeExecutor(undefined as never)).toThrow(/opts is required/);
  });
  it("rejects missing kernel", () => {
    expect(() => createCodemodeExecutor({} as never)).toThrow(/kernel must be a WasmKernel/);
  });
});

describe("createCodemodeExecutor — flat Record providers", () => {
  it("calls a single tool and returns its result", async () => {
    const kernel = new JsKernel();
    const exec = createCodemodeExecutor({ kernel });
    const got = await exec.execute(`return await tools.add({ a: 2, b: 3 });`, {
      // Object-arg fn: receives the arg object as a single parameter.
      add: async (a: unknown) => {
        const { a: x, b: y } = a as { a: number; b: number };
        return x + y;
      },
    });
    expect(got.error).toBeUndefined();
    expect(got.result).toBe(5);
    await kernel[Symbol.asyncDispose]();
  });

  it("chains multiple tools without returning to the host between calls", async () => {
    const kernel = new JsKernel();
    const exec = createCodemodeExecutor({ kernel });
    const got = await exec.execute(
      `
      const a = await tools.double({ n: 4 });
      const b = await tools.double({ n: a });
      return b;
      `,
      {
        double: async (a: unknown) => {
          const { n } = a as { n: number };
          return n * 2;
        },
      }
    );
    expect(got.result).toBe(16);
    await kernel[Symbol.asyncDispose]();
  });
});

describe("createCodemodeExecutor — namespaced ResolvedProvider[]", () => {
  it("dispatches via the namespaced shape", async () => {
    const kernel = new JsKernel();
    const exec = createCodemodeExecutor({ kernel });
    const got = await exec.execute(`return await tools.weather.getCurrent({ location: 'SF' });`, [
      {
        name: "weather",
        fns: {
          getCurrent: async (a: unknown) => {
            const { location } = a as { location: string };
            return `Weather in ${location}: 72F`;
          },
        },
      },
    ]);
    expect(got.result).toBe("Weather in SF: 72F");
    await kernel[Symbol.asyncDispose]();
  });

  it("honors positionalArgs=true", async () => {
    const kernel = new JsKernel();
    const exec = createCodemodeExecutor({ kernel });
    const got = await exec.execute(`return await tools.math.sum(1, 2, 3);`, [
      {
        name: "math",
        positionalArgs: true,
        fns: {
          sum: async (...nums: unknown[]) => (nums as number[]).reduce((s, n) => s + n, 0),
        },
      },
    ]);
    expect(got.result).toBe(6);
    await kernel[Symbol.asyncDispose]();
  });
});

describe("createCodemodeExecutor — console + errors", () => {
  it("captures console.log into logs[]", async () => {
    const kernel = new JsKernel();
    const exec = createCodemodeExecutor({ kernel });
    const got = await exec.execute(`console.log("hello"); console.warn("warned"); return 42;`, {});
    expect(got.result).toBe(42);
    // Each kernel collects console.* into KernelResult.logs and we
    // accumulate those across iterations. JsKernel formats as
    // `args.map(String).join(" ")` (no level prefix), so we just
    // check the user-visible substrings appear.
    expect(got.logs?.some((l) => l.includes("hello"))).toBe(true);
    expect(got.logs?.some((l) => l.includes("warned"))).toBe(true);
    await kernel[Symbol.asyncDispose]();
  });

  it("surfaces a thrown tool error as the script's final error", async () => {
    // Note: cloudflare codemode LLMs rarely wrap `await tools.x()` in
    // try/catch — the streamText step loop handles errors. Wrapping a
    // tool call in try/catch in the LLM-emitted script is a known edge
    // case that swallows the executor's pause marker (see codemodeExecutor.ts
    // docblock); here we test the bare throw path which is the real shape.
    const kernel = new JsKernel();
    const exec = createCodemodeExecutor({ kernel });
    const got = await exec.execute(`return await tools.boom({});`, {
      boom: async () => {
        throw new Error("kaboom");
      },
    });
    expect(got.error).toMatch(/kaboom/);
    await kernel[Symbol.asyncDispose]();
  });

  it("fails fast on unknown tool name", async () => {
    const kernel = new JsKernel();
    const exec = createCodemodeExecutor({ kernel });
    const got = await exec.execute(`return await tools.missing({});`, {});
    // `tools.missing` is not registered on the proxy — accessing it
    // throws synchronously inside the script with our sentinel message.
    expect(got.error).toMatch(/unknown tool "missing"/);
    await kernel[Symbol.asyncDispose]();
  });
});

describe("createCodemodeExecutor — runtime errors", () => {
  it("rejects on syntax errors from user code", async () => {
    const kernel = new JsKernel();
    const exec = createCodemodeExecutor({ kernel });
    // Syntax errors fail at the kernel level (new Script() parse failure)
    // and propagate as a rejected promise from execute().
    await expect(exec.execute(`return 1 + ;`, {})).rejects.toThrow(
      /KernelError|Unexpected token|syntax error/i
    );
    await kernel[Symbol.asyncDispose]();
  });

  it("surfaces ReferenceError from user code as the executor error", async () => {
    const kernel = new JsKernel();
    const exec = createCodemodeExecutor({ kernel });
    // The async IIFE wrapper catches ReferenceError and returns it
    // in the { done: true, error: ... } envelope.
    const got = await exec.execute(`return nonexistentVar;`, {});
    expect(got.error).toBeDefined();
    expect(got.error).toMatch(/nonexistentVar|is not defined/);
    await kernel[Symbol.asyncDispose]();
  });

  it("surfaces TypeError from user code as the executor error", async () => {
    const kernel = new JsKernel();
    const exec = createCodemodeExecutor({ kernel });
    const got = await exec.execute(`return (null).foo;`, {});
    expect(got.error).toBeDefined();
    expect(got.error).toMatch(/Cannot read propert|Cannot read the propert|null is not an object/);
    await kernel[Symbol.asyncDispose]();
  });
});

describe("createCodemodeExecutor — bounds", () => {
  it("respects maxIterations", async () => {
    // A script that emits a fresh tool-call each iteration — without a
    // bound, it would loop forever. The marker-rerun loop should
    // terminate cleanly when maxIterations is reached and surface the
    // partial state.
    const kernel = new JsKernel();
    const exec = createCodemodeExecutor({
      kernel,
      maxIterations: 3,
    });
    const got = await exec.execute(
      `
      let total = 0;
      for (let i = 0; i < 100; i++) total += await tools.inc({});
      return total;
      `,
      {
        inc: async () => 1,
      }
    );
    // After 3 iterations we should not have completed (100 calls needed).
    // The return shape: result/error are undefined, the loop hit its cap.
    expect(got.result).toBeUndefined();
    // We don't require a specific error string here — the contract is
    // "stops cleanly", not "produces a specific message". The test would
    // fail if the loop ran unbounded (timeout) or threw.
    await kernel[Symbol.asyncDispose]();
  });

  it("terminates a synchronous infinite loop via kernel timeout", async () => {
    // A true infinite loop (while(true) with no tool calls) should be
    // caught by the kernel's own timeout mechanism, not by maxIterations.
    const kernel = new JsKernel({ timeoutMs: 500 });
    const exec = createCodemodeExecutor({ kernel, capabilities: { cpuMs: 300 } });
    // The kernel timeout kills the worker thread; execute() rejects.
    await expect(exec.execute(`while (true) {}`, {})).rejects.toThrow(
      /timeout|timed out|KernelError/i
    );
    await kernel[Symbol.asyncDispose]();
  });
});

describe("createCodemodeExecutor — blocked host access", () => {
  it("denies fetch when allowedHosts is empty (default deny-all)", async () => {
    const kernel = new JsKernel();
    const exec = createCodemodeExecutor({ kernel });
    // With no allowedHosts, fetch is not injected into the sandbox.
    // Calling fetch triggers a ReferenceError inside the async IIFE wrapper,
    // which surfaces as got.error.
    const got = await exec.execute(`return fetch("https://example.com");`, {});
    expect(got.error).toMatch(/fetch is not defined/);
    await kernel[Symbol.asyncDispose]();
  });

  it("denies require in the sandbox", async () => {
    const kernel = new JsKernel();
    const exec = createCodemodeExecutor({ kernel });
    const got = await exec.execute(`return require("fs");`, {});
    expect(got.error).toMatch(/require is not defined/);
    await kernel[Symbol.asyncDispose]();
  });

  it("denies process in the sandbox", async () => {
    const kernel = new JsKernel();
    const exec = createCodemodeExecutor({ kernel });
    const got = await exec.execute(`return process.env;`, {});
    expect(got.error).toMatch(/process is not defined/);
    await kernel[Symbol.asyncDispose]();
  });
});

describe("createCodemodeExecutor — disposal and reuse", () => {
  it("rejects execute after kernel disposal", async () => {
    const kernel = new JsKernel();
    const exec = createCodemodeExecutor({ kernel });
    await kernel[Symbol.asyncDispose]();
    // After disposal, the kernel should throw on run().
    await expect(exec.execute(`return 1;`, {})).rejects.toThrow(/disposed|cannot run/);
  });

  it("allows multiple sequential execute calls on the same executor", async () => {
    const kernel = new JsKernel();
    const exec = createCodemodeExecutor({ kernel });
    const first = await exec.execute(`return 1 + 1;`, {});
    expect(first.result).toBe(2);
    const second = await exec.execute(`return 2 + 3;`, {});
    expect(second.result).toBe(5);
    await kernel[Symbol.asyncDispose]();
  });

  it("returns null for code that implicitly returns undefined", async () => {
    const kernel = new JsKernel();
    const exec = createCodemodeExecutor({ kernel });
    const got = await exec.execute(`var x = 42;`, {});
    // The wrapper converts undefined to null in the JSON envelope.
    expect(got.result).toBeNull();
    await kernel[Symbol.asyncDispose]();
  });
});
