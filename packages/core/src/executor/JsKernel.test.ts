import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JsKernel } from "../executor/JsKernel.js";

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

  it("snapshot() throws NotImplemented", async () => {
    await kernel.run("var z = 42;");
    await expect(kernel.snapshot()).rejects.toThrow(/does not support snapshot/);
  });

  it("restore() throws NotImplemented", async () => {
    await expect(kernel.restore(new Uint8Array())).rejects.toThrow(/does not support snapshot/);
  });

  it("[Symbol.asyncDispose] terminates the worker cleanly", async () => {
    await kernel.run("var d = 99;");
    await expect(kernel[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });
});
