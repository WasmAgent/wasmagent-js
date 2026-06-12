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
 * (g) maxIterations bounds runaway scripts.
 *
 * We use `JsKernel` for speed (no WASM init); the executor itself is
 * kernel-agnostic — replacing JsKernel with QuickJSKernel should be
 * orthogonal to these tests.
 */

import { JsKernel } from "@agentkit-js/core";
import { describe, expect, it } from "vitest";
import { agentkitCodemodeExecutor } from "./codemodeExecutor.js";

describe("agentkitCodemodeExecutor — construction", () => {
  it("rejects missing opts", () => {
    expect(() => agentkitCodemodeExecutor(undefined as never)).toThrow(/opts is required/);
  });
  it("rejects missing kernel", () => {
    expect(() => agentkitCodemodeExecutor({} as never)).toThrow(/kernel must be a WasmKernel/);
  });
});

describe("agentkitCodemodeExecutor — flat Record providers", () => {
  it("calls a single tool and returns its result", async () => {
    const exec = agentkitCodemodeExecutor({ kernel: new JsKernel() });
    const got = await exec.execute(
      `return await tools.add({ a: 2, b: 3 });`,
      {
        // Object-arg fn: receives the arg object as a single parameter.
        add: async (a: unknown) => {
          const { a: x, b: y } = a as { a: number; b: number };
          return x + y;
        },
      }
    );
    expect(got.error).toBeUndefined();
    expect(got.result).toBe(5);
  });

  it("chains multiple tools without returning to the host between calls", async () => {
    const exec = agentkitCodemodeExecutor({ kernel: new JsKernel() });
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
  });
});

describe("agentkitCodemodeExecutor — namespaced ResolvedProvider[]", () => {
  it("dispatches via the namespaced shape", async () => {
    const exec = agentkitCodemodeExecutor({ kernel: new JsKernel() });
    const got = await exec.execute(
      `return await tools.weather.getCurrent({ location: 'SF' });`,
      [
        {
          name: "weather",
          fns: {
            getCurrent: async (a: unknown) => {
              const { location } = a as { location: string };
              return `Weather in ${location}: 72F`;
            },
          },
        },
      ]
    );
    expect(got.result).toBe("Weather in SF: 72F");
  });

  it("honors positionalArgs=true", async () => {
    const exec = agentkitCodemodeExecutor({ kernel: new JsKernel() });
    const got = await exec.execute(`return await tools.math.sum(1, 2, 3);`, [
      {
        name: "math",
        positionalArgs: true,
        fns: {
          sum: async (...nums: unknown[]) =>
            (nums as number[]).reduce((s, n) => s + n, 0),
        },
      },
    ]);
    expect(got.result).toBe(6);
  });
});

describe("agentkitCodemodeExecutor — console + errors", () => {
  it("captures console.log into logs[]", async () => {
    const exec = agentkitCodemodeExecutor({ kernel: new JsKernel() });
    const got = await exec.execute(
      `console.log("hello"); console.warn("warned"); return 42;`,
      {}
    );
    expect(got.result).toBe(42);
    // Each kernel collects console.* into KernelResult.logs and we
    // accumulate those across iterations. JsKernel formats as
    // `args.map(String).join(" ")` (no level prefix), so we just
    // check the user-visible substrings appear.
    expect(got.logs?.some((l) => l.includes("hello"))).toBe(true);
    expect(got.logs?.some((l) => l.includes("warned"))).toBe(true);
  });

  it("surfaces a thrown tool error as the script's final error", async () => {
    // Note: cloudflare codemode LLMs rarely wrap `await tools.x()` in
    // try/catch — the streamText step loop handles errors. Wrapping a
    // tool call in try/catch in the LLM-emitted script is a known edge
    // case that swallows the executor's pause marker (see codemodeExecutor.ts
    // docblock); here we test the bare throw path which is the real shape.
    const exec = agentkitCodemodeExecutor({ kernel: new JsKernel() });
    const got = await exec.execute(`return await tools.boom({});`, {
      boom: async () => {
        throw new Error("kaboom");
      },
    });
    expect(got.error).toMatch(/kaboom/);
  });

  it("fails fast on unknown tool name", async () => {
    const exec = agentkitCodemodeExecutor({ kernel: new JsKernel() });
    const got = await exec.execute(`return await tools.missing({});`, {});
    // `tools.missing` is not registered on the proxy — accessing it
    // throws synchronously inside the script with our sentinel message.
    expect(got.error).toMatch(/unknown tool "missing"/);
  });
});

describe("agentkitCodemodeExecutor — bounds", () => {
  it("respects maxIterations", async () => {
    // A script that emits a fresh tool-call each iteration — without a
    // bound, it would loop forever. The marker-rerun loop should
    // terminate cleanly when maxIterations is reached and surface the
    // partial state.
    const exec = agentkitCodemodeExecutor({
      kernel: new JsKernel(),
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
  });
});
