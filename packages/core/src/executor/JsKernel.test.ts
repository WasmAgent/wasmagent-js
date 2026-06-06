import { describe, it, expect, beforeEach } from "vitest";
import { JsKernel } from "../executor/JsKernel.js";

describe("JsKernel", () => {
  let kernel: JsKernel;

  beforeEach(() => {
    kernel = new JsKernel();
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

  it("persists variables across steps (stateful kernel)", async () => {
    await kernel.run("var x = 10;");
    const result = await kernel.run("x * 2");
    expect(result.output).toBe(20);
  });

  it("signals final answer via __finalAnswer__", async () => {
    const result = await kernel.run('__finalAnswer__ = "done";');
    expect(result.isFinalAnswer).toBe(true);
    expect(result.output).toBe("done");
  });

  it("resets state on reset()", async () => {
    await kernel.run("var y = 99;");
    await kernel.reset();
    await expect(kernel.run("y")).rejects.toThrow();
  });

  it("denies access to fetch (capability deny-all)", async () => {
    await expect(kernel.run("fetch('https://example.com')")).rejects.toThrow();
  });

  it("denies access to process (capability deny-all)", async () => {
    await expect(kernel.run("process.env")).rejects.toThrow();
  });

  it("snapshot() throws NotImplemented", async () => {
    await kernel.run("var z = 42;");
    await expect(kernel.snapshot()).rejects.toThrow(/does not support snapshot/);
  });

  it("restore() throws NotImplemented", async () => {
    await expect(kernel.restore(new Uint8Array())).rejects.toThrow(/does not support snapshot/);
  });

  it("[Symbol.asyncDispose] resolves without error", async () => {
    await kernel.run("var d = 99;");
    await expect(kernel[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });
});
