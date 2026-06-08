import { describe, expect, it } from "vitest";
import { PyodideKernel } from "./PyodideKernel.js";

describe("PyodideKernel (A4)", () => {
  it("executes simple Python and returns output", async () => {
    const kernel = new PyodideKernel();
    const result = await kernel.run("2 + 3");
    expect(result.output).toBe(5);
    expect(result.isFinalAnswer).toBe(false);
  }, 30_000); // Pyodide loads ~300ms, allow generous timeout

  it("captures print() as logs", async () => {
    const kernel = new PyodideKernel();
    const result = await kernel.run('print("hello from python")');
    expect(result.logs).toContain("hello from python");
  }, 30_000);

  it("persists variables across run() calls (stateful kernel)", async () => {
    const kernel = new PyodideKernel();
    await kernel.run("x = 21");
    const result = await kernel.run("x * 2");
    expect(result.output).toBe(42);
  }, 30_000);

  it("signals final answer via __final_answer__", async () => {
    const kernel = new PyodideKernel();
    const result = await kernel.run("__final_answer__ = 'done'");
    expect(result.isFinalAnswer).toBe(true);
    expect(result.output).toBe("done");
  }, 30_000);

  it("raises KernelError on invalid Python syntax", async () => {
    const kernel = new PyodideKernel();
    await expect(kernel.run("def broken(")).rejects.toThrow(/PyodideKernelError/);
  }, 30_000);

  it("reset() clears Python globals", async () => {
    const kernel = new PyodideKernel();
    await kernel.run("my_var = 99");
    await kernel.reset();
    const result = await kernel.run("'my_var' in dir()");
    expect(result.output).toBe(false);
  }, 30_000);

  it("snapshot/restore round-trip preserves numeric globals", async () => {
    const kernel = new PyodideKernel();
    await kernel.run("counter = 7");
    const snap = await kernel.snapshot();
    await kernel.reset();
    await kernel.restore(snap);
    const result = await kernel.run("counter");
    expect(result.output).toBe(7);
  }, 60_000);

  it("[Symbol.asyncDispose] resolves without error", async () => {
    const kernel = new PyodideKernel();
    await kernel.run("tmp = 1");
    await expect(kernel[Symbol.asyncDispose]()).resolves.toBeUndefined();
  }, 30_000);
});
