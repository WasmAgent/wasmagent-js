import { JsKernel, memoryBytesToResourceLimits } from "../executor/JsKernel.js";

describe("JsKernel (worker_threads isolation)", () => {
  let kernel: JsKernel;

  beforeEach(() => {
    kernel = new JsKernel();
  });

  afterEach(async () => {
    await kernel[Symbol.asyncDispose]();
  });

  it("executes simple JS and returns output", async () => {
    const result = await kernel.run("1 + 2");
    expect(result.output).toBe(3);
    expect(result.isFinalAnswer).toBe(false);
  });

  it("captures console.log as logs", async () => {
    const result = await kernel.run('console.log("hello"); 42');
    expect(result.logs).toContain("hello");
    expect(result.output).toBe(42);
  });

  it("persists variables across steps (stateful kernel — long-lived worker)", async () => {
    await kernel.run("var x = 10;");
    const result = await kernel.run("x * 2");
    expect(result.output).toBe(20);
  });

  it("signals final answer via __finalAnswer__", async () => {
    const result = await kernel.run('__finalAnswer__ = "done";');
    expect(result.isFinalAnswer).toBe(true);
    expect(result.output).toBe("done");
  });

  it("null is a valid final answer (isFinalAnswer = true when __finalAnswer__ = null)", async () => {
    const result = await kernel.run("__finalAnswer__ = null;");
    expect(result.isFinalAnswer).toBe(true);
    expect(result.output).toBeNull();
  });

  it("resets state on reset() — spawns fresh worker", async () => {
    await kernel.run("var y = 99;");
    await kernel.reset();
    await expect(kernel.run("y")).rejects.toThrow();
  });

  it("denies access to fetch (capability deny-all, no allowedHosts)", async () => {
    await expect(kernel.run("fetch('https://example.com')")).rejects.toThrow();
  });

  it("denies access to process (not in sandbox)", async () => {
    await expect(kernel.run("process.env")).rejects.toThrow();
  });

  it("timeoutMs: kills synchronous infinite loop without leaving zombie threads", async () => {
    // Previous impl: while(true){} locked the vitest worker thread for timeoutMs (50ms)
    // then threw — vitest treated the worker as crashed, leaving zombie Node processes.
    // New impl: code runs in a dedicated worker_threads Worker; Atomics.wait times out,
    // worker.terminate() fully kills the OS thread, caller gets a clean rejection.
    const timedKernel = new JsKernel({ timeoutMs: 200 });
    try {
      await expect(timedKernel.run("while(true){}")).rejects.toThrow(/timed out/);
      // Verify no zombie: next run on a fresh kernel works normally
      const fresh = new JsKernel();
      const r = await fresh.run("1 + 1");
      expect(r.output).toBe(2);
      await fresh[Symbol.asyncDispose]();
    } finally {
      await timedKernel[Symbol.asyncDispose]();
    }
  }, 5_000);

  it("snapshot and restore are not implemented (optional interface)", async () => {
    const k = kernel as import("./types.js").WasmKernel;
    expect(k.snapshot).toBeUndefined();
    expect(k.restore).toBeUndefined();
  });

  it("[Symbol.asyncDispose] terminates the worker cleanly", async () => {
    await kernel.run("var d = 99;");
    await expect(kernel[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });

  // ── Issue #192: configurable CPU time and memory limits ────────────────────
  // CPU time is already bounded by `timeoutMs` / per-call `cpuMs` (see the
  // "cpuMs override" tests in capabilities.test.ts). These tests pin the memory
  // half: a hard V8 heap cap on the worker via node:worker_threads resourceLimits.
  it("memoryLimitBytes: a runaway allocation is rejected when it blows the heap cap (issue #192)", async () => {
    // 16 MiB cap: enough for worker bootstrap, but a tight allocation loop
    // exhausts the old-generation heap within a few iterations. V8 aborts the
    // worker with a FATAL OOM; JsKernel surfaces that worker exit as a run()
    // rejection rather than waiting out the timeout.
    const capped = new JsKernel({ maxMemoryBytes: 16 * 1024 * 1024 });
    try {
      await expect(
        capped.run(`
          var sink = [];
          while (true) { sink.push("x".repeat(2 * 1024 * 1024)); }
        `)
      ).rejects.toThrow(/KernelError/);
    } finally {
      await capped[Symbol.asyncDispose]();
    }
  }, 15_000);

  it("memoryLimitBytes does not break normal execution when the cap is generous (issue #192)", async () => {
    const capped = new JsKernel({ maxMemoryBytes: 64 * 1024 * 1024 });
    try {
      const result = await capped.run("var a = [1,2,3]; a.reduce((x,y) => x+y, 0)");
      expect(result.output).toBe(6);
    } finally {
      await capped[Symbol.asyncDispose]();
    }
  });
});

describe("memoryBytesToResourceLimits (issue #192)", () => {
  it("returns undefined when no limit is configured", () => {
    expect(memoryBytesToResourceLimits(undefined)).toBeUndefined();
    expect(memoryBytesToResourceLimits(0)).toBeUndefined();
    expect(memoryBytesToResourceLimits(-1)).toBeUndefined();
  });

  it("rounds UP to whole MiB so the cap is never silently widened", () => {
    expect(memoryBytesToResourceLimits(1)).toEqual({ maxOldGenerationSizeMb: 1 });
    expect(memoryBytesToResourceLimits(1024 * 1024)).toEqual({ maxOldGenerationSizeMb: 1 });
    expect(memoryBytesToResourceLimits(1024 * 1024 + 1)).toEqual({ maxOldGenerationSizeMb: 2 });
    expect(memoryBytesToResourceLimits(5 * 1024 * 1024)).toEqual({ maxOldGenerationSizeMb: 5 });
  });
});
