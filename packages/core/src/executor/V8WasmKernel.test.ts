import { describe, it, expect } from "vitest";
import { V8WasmKernel } from "../executor/V8WasmKernel.js";

describe("V8WasmKernel", () => {
  it("executes simple JS and returns output", async () => {
    const kernel = new V8WasmKernel();
    const result = await kernel.run("1 + 2");
    expect(result.output).toBe(3);
    expect(result.isFinalAnswer).toBe(false);
  });

  it("captures console.log as logs", async () => {
    const kernel = new V8WasmKernel();
    const result = await kernel.run('console.log("v8wasm"); 42');
    expect(result.logs).toContain("v8wasm");
    expect(result.output).toBe(42);
  });

  it("persists variables across steps", async () => {
    const kernel = new V8WasmKernel();
    await kernel.run("var x = 10;");
    const result = await kernel.run("x * 3");
    expect(result.output).toBe(30);
  });

  it("signals final answer via __finalAnswer__", async () => {
    const kernel = new V8WasmKernel();
    const result = await kernel.run('__finalAnswer__ = "v8done";');
    expect(result.isFinalAnswer).toBe(true);
    expect(result.output).toBe("v8done");
  });

  it("resets state on reset()", async () => {
    const kernel = new V8WasmKernel();
    await kernel.run("var y = 99;");
    await kernel.reset();
    await expect(kernel.run("y")).rejects.toThrow();
  });

  it("denies access to fetch (capability deny-all)", async () => {
    const kernel = new V8WasmKernel();
    await expect(kernel.run("fetch('https://example.com')")).rejects.toThrow();
  });

  it("supports snapshot/restore round-trip", async () => {
    const kernel = new V8WasmKernel();
    await kernel.run("var z = 77;");
    const snap = await kernel.snapshot();
    await kernel.reset();
    await kernel.restore(snap);
    const result = await kernel.run("z");
    expect(result.output).toBe(77);
  });

  it("injects capability globals via run() capabilities parameter", async () => {
    const kernel = new V8WasmKernel();
    const result = await kernel.run(
      "typeof fetch",
      { allowedHosts: ["api.example.com"] }
    );
    expect(result.output).toBe("function");
  });

  it("[Symbol.asyncDispose] resolves without error", async () => {
    const kernel = new V8WasmKernel();
    await kernel.run("var q = 5;");
    await expect(kernel[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });
});
