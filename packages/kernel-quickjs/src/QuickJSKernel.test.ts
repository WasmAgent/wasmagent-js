import { describe, it, expect, afterAll } from "vitest";
import { QuickJSKernel } from "./QuickJSKernel.js";

// One shared kernel for the file — avoids multiple QuickJS runtime init/dispose
// cycles which cause WASM GC assertion failures on process exit.
const kernel = new QuickJSKernel();

describe("QuickJSKernel (edge-safe, no node:vm)", () => {
  afterAll(async () => {
    await kernel[Symbol.asyncDispose]();
  });

  it("executes simple JS and returns output", async () => {
    const result = await kernel.run("1 + 2");
    expect(result.output).toBe(3);
    expect(result.isFinalAnswer).toBe(false);
  });

  it("captures console.log as logs", async () => {
    const result = await kernel.run('console.log("hello from quickjs"); 42');
    expect(result.logs).toContain("hello from quickjs");
    expect(result.output).toBe(42);
  });

  it("persists variables across run() calls (stateful context)", async () => {
    await kernel.run("var x = 21;");
    const result = await kernel.run("x * 2");
    expect(result.output).toBe(42);
  });

  it("signals final answer via __finalAnswer__", async () => {
    const result = await kernel.run('__finalAnswer__ = "done";');
    expect(result.isFinalAnswer).toBe(true);
    expect(result.output).toBe("done");
  });

  it("resets state on reset()", async () => {
    await kernel.run("var y = 99;");
    await kernel.reset();
    await expect(kernel.run("y")).rejects.toThrow(/KernelError/);
  });

  it("throws KernelError on invalid syntax", async () => {
    await expect(kernel.run("def broken(")).rejects.toThrow(/KernelError/);
  });

  it("kills synchronous infinite loop via interrupt handler", async () => {
    const timedKernel = new QuickJSKernel({ timeoutMs: 500 });
    await expect(timedKernel.run("while(true){}")).rejects.toThrow(/timed out/);
    // After timeout, kernel auto-resets — next call should work.
    const result = await timedKernel.run("2 + 2");
    expect(result.output).toBe(4);
    await timedKernel[Symbol.asyncDispose]();
  }, 5_000);

  it("snapshot() throws NotImplemented", async () => {
    await expect(kernel.snapshot()).rejects.toThrow(/does not support snapshot/);
  });
});
