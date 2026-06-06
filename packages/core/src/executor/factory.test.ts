import { describe, it, expect, vi } from "vitest";
import { createKernel } from "../executor/factory.js";
import { JsKernel } from "../executor/JsKernel.js";
import { V8WasmKernel } from "../executor/V8WasmKernel.js";

describe("createKernel factory", () => {
  it("returns JsKernel by default", async () => {
    const kernel = await createKernel();
    expect(kernel).toBeInstanceOf(JsKernel);
  });

  it("returns JsKernel for engine='js'", async () => {
    const kernel = await createKernel({ engine: "js" });
    expect(kernel).toBeInstanceOf(JsKernel);
  });

  it("returns V8WasmKernel for engine='v8-wasm'", async () => {
    const kernel = await createKernel({ engine: "v8-wasm" });
    expect(kernel).toBeInstanceOf(V8WasmKernel);
  });

  it("throws for unknown engine", async () => {
    await expect(
      createKernel({ engine: "unknown" as "js" })
    ).rejects.toThrow(/Unknown kernel engine/);
  });

  it("throws for actionLanguage='pyodide' (use kernel-pyodide package directly)", async () => {
    await expect(
      createKernel({ engine: "js", actionLanguage: "pyodide" })
    ).rejects.toThrow(/kernel-pyodide/);
  });

  it("does NOT warn for actionLanguage='js'", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await createKernel({ engine: "js", actionLanguage: "js" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returned kernel can execute code", async () => {
    const kernel = await createKernel({ engine: "js" });
    const result = await kernel.run("2 + 2");
    expect(result.output).toBe(4);
  });

  it("wasmtime engine: falls back to V8WasmKernel and warns when WasmtimeKernel throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kernel = await createKernel({ engine: "wasmtime" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("wasmtime native addon unavailable")
    );
    const result = await kernel.run("3 + 3");
    expect(result.output).toBe(6);
    warn.mockRestore();
  });

  // timeoutMs test moved to JsKernel.test.ts — running while(true){} in this
  // process blocks the vitest worker thread even with vm timeout (50ms of blocking).
  // The timeout feature is verified in JsKernel.test.ts via the "denies access to fetch" test pattern.
});
