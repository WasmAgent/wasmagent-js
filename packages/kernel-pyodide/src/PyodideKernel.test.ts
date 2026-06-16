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

  it("exposes capability env as __env__ and os.environ (frozen per call)", async () => {
    const kernel = new PyodideKernel();

    // Call 1: env is set; both spellings should be visible.
    // We return JSON strings to avoid Pyodide JsProxy ↔ deep-equal issues
    // (Pyodide proxies dict objects; vitest's .toEqual on a JsProxy throws
    // TypeError: unhashable type). Stringify in Python, parse in JS.
    const r1 = await kernel.run(
      `import os, json
json.dumps({
  "from_env_global": __env__.get("API_KEY"),
  "from_os_environ":  os.environ.get("API_KEY"),
  "all_keys":         sorted(__env__.keys()),
})`,
      { env: { API_KEY: "sk-test-1", REGION: "us-east-1" } }
    );
    expect(JSON.parse(r1.output as string)).toEqual({
      from_env_global: "sk-test-1",
      from_os_environ: "sk-test-1",
      all_keys: ["API_KEY", "REGION"],
    });

    // Call 2: a different env wipes the prior call's keys (no leak).
    const r2 = await kernel.run(
      `import os, json
json.dumps({
  "api_key_now": os.environ.get("API_KEY"),
  "region_now":  os.environ.get("REGION"),
  "fresh_key":   os.environ.get("FRESH"),
})`,
      { env: { FRESH: "v" } }
    );
    expect(JSON.parse(r2.output as string)).toEqual({
      api_key_now: null,
      region_now: null,
      fresh_key: "v",
    });

    // Call 3: omit env entirely — os.environ should be empty.
    const r3 = await kernel.run(`import os; len(os.environ)`);
    expect(r3.output).toBe(0);

    await kernel[Symbol.asyncDispose]();
  }, 30_000);
});
